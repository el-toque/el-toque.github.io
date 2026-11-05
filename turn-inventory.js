(() => {
"use strict";
const $=id=>document.getElementById(id), money=n=>new Intl.NumberFormat("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+" CUP";
const dateKey=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let db=null,session=null,shift=0,rows=[],closure=null,ready=false,working=false;
const denominations=[5000,2000,1000,500,200,100,50,20,10,5,3,1];
const key=()=> "ipv_turn_draft_"+session.user.id+"_"+dateKey()+"_"+shift;
function row(product="",start=0,entry=0,sold=0,price=0){return {product,start,entry,sold,price};}
function calc(r){const available=Number(r.start)+Number(r.entry),sold=Number(r.sold),price=Number(r.price);return {available,final:available-sold,amount:sold*price};}
function total(){return rows.reduce((n,r)=>n+calc(r).amount,0);}
function render(){
 const body=$("turnRows");if(!body)return;
 body.innerHTML=rows.map((r,i)=>{const c=calc(r);return `<tr data-row="${i}">
 <td><input data-field="product" value="${esc(r.product)}" aria-label="Producto ${i+1}" maxlength="120"></td>
 <td><input data-field="start" type="number" min="0" step="1" inputmode="decimal" value="${r.start}"></td>
 <td><input data-field="entry" type="number" min="0" step="1" inputmode="decimal" value="${r.entry}"></td>
 <td class="calculated">${c.available}</td>
 <td class="calculated">${c.final}</td>
 <td><input data-field="sold" type="number" min="0" step="1" inputmode="decimal" value="${r.sold}"></td>
 <td><input data-field="price" type="number" min="0" step="0.01" inputmode="decimal" value="${r.price}"></td>
 <td class="calculated amount">${money(c.amount)}</td>
 </tr>`;}).join("");
 $("turnGrandTotal").textContent=money(total());
 $("turnRowsCount").textContent=rows.length+" filas";
}
function status(t){$("turnStatus").textContent=t;}
async function saveDraft(){try{localStorage.setItem(key(),JSON.stringify(rows));}catch(e){status("No se pudo guardar el borrador en este teléfono.");}}
function shiftLabel(){return shift===1?"Turno 1":"Turno 2";}
function setMeta(){ $("turnShift").textContent=shiftLabel();$("turnDate").textContent=new Date().toLocaleDateString("es-ES",{weekday:"long",year:"numeric",month:"long",day:"numeric"}); }
async function load(){
 const {data:last,error}=await db.rpc("get_last_worker_turn");
 if(error)throw error;
 const day=dateKey();
 if(shift===2){
   if(!last||last.shift_no!==1||last.business_date!==day)throw new Error("El Turno 2 estará disponible cuando se haya cerrado el Turno 1 de hoy.");
   rows=(last.rows||[]).map(r=>row(r.product,r.final,0,0,r.price));
 } else if(last?.shift_no===2){
   rows=(last.rows||[]).map(r=>row(r.product,r.final,0,0,r.price));
 } else if(last?.shift_no===1){
   if(last.business_date===day)throw new Error("El Turno 1 de hoy ya fue cerrado. Corresponde trabajar con el Turno 2.");
   throw new Error("Falta cerrar el Turno 2 de la fecha "+last.business_date+". No se puede iniciar otro día hasta completar ese cierre.");
 } else {
   const {data:allocs,error:allocError}=await db.from("worker_stock_allocations").select("product_id,quantity_remaining").eq("worker_id",session.user.id);
   if(allocError)throw allocError;
   const ids=(allocs||[]).map(a=>a.product_id);
   const {data:catalog,error:catalogError}=ids.length?await db.from("products").select("id,name,price").in("id",ids):{data:[],error:null};
   if(catalogError)throw catalogError;
   const byId=new Map((catalog||[]).map(p=>[p.id,p]));
   const seeded=(allocs||[]).map(a=>{const p=byId.get(a.product_id);return row(p?.name||"",Number(a.quantity_remaining)||0,0,0,Number(p?.price)||0);}).filter(r=>r.product);
   rows=seeded.length?seeded:Array.from({length:20},()=>row());
 }
 const saved=localStorage.getItem(key());
 if(saved){try{const draft=JSON.parse(saved);if(Array.isArray(draft)&&draft.length)rows=draft;}catch(_){}}
 if(rows.length<20)rows.push(...Array.from({length:20-rows.length},()=>row()));
 closure=null;setMeta();$("turnDocumentNo").textContent="N°"+String((last?.closure_no||0)+1).padStart(2,"0");render();
 $("closeTurnBtn").disabled=false;
 status("Puedes editar las celdas habilitadas. Las columnas calculadas están protegidas.");
 await history();
}
async function history(){
 const {data,error}=await db.from("worker_turn_closures").select("closure_no,shift_no,business_date,total,created_at").order("closure_no",{ascending:false}).limit(12);
 if(error){$("turnHistory").innerHTML="<p>No se pudo cargar el historial.</p>";return;}
 $("turnHistory").innerHTML=(data||[]).map(x=>`<div class="turn-history-row"><strong>N°${String(x.closure_no).padStart(2,"0")} · Turno ${x.shift_no}</strong><span>${esc(x.business_date)} · ${money(x.total)}</span></div>`).join("")||"<p class='muted small'>Todavía no hay turnos cerrados.</p>";
}
function exportData(savedRows,number,shiftNo,date){
 const billCounts={};document.querySelectorAll("#dailyBillsBody [data-bill-denomination]").forEach(el=>billCounts[el.dataset.billDenomination]=Number(el.value)||0);
 const bills=denominations.filter(v=>billCounts[v]>0).map(v=>({"Denominación":v+" CUP","Cantidad de billetes":billCounts[v],"Importe":v*billCounts[v]}));
 const billTotal=denominations.reduce((n,v)=>n+v*(billCounts[v]||0),0);
 bills.push({"Denominación":"TOTAL EFECTIVO CONTADO","Cantidad de billetes":denominations.reduce((n,v)=>n+(billCounts[v]||0),0),"Importe":billTotal});
 if(window.XLSX){const data=savedRows.map(r=>({Producto:r.product,Inicio:r.start,Entrada:r.entry,Disponible:r.available,Final:r.final,Vendido:r.sold,Precio:r.price,Importe:r.amount}));
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),"Turno");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(bills),"Conteo de billetes");
 XLSX.writeFile(wb,"IPV_Turno_"+number+"_"+date+".xlsx");}
 if(window.jspdf?.jsPDF){const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
 doc.setFontSize(16);doc.text("IPV Digital · "+shiftLabel()+" · N°"+String(number).padStart(2,"0"),14,14);doc.setFontSize(10);doc.text("Fecha: "+date,14,21);
 doc.autoTable({startY:26,head:[["Producto","Inicio","Entrada","Disponible","Final","Vendido","Precio","Importe"]],body:savedRows.map(r=>[r.product,r.start,r.entry,r.available,r.final,r.sold,r.price.toFixed(2),r.amount.toFixed(2)]),styles:{fontSize:8},headStyles:{fillColor:[45,38,24]}});
 doc.autoTable({startY:doc.lastAutoTable.finalY+8,head:[["Denominación","Cantidad","Importe"]],body:bills.map(b=>[b["Denominación"],b["Cantidad de billetes"],b.Importe.toFixed(2)]),styles:{fontSize:8}});
 doc.save("IPV_Turno_"+number+"_"+date+".pdf");}
}
async function init(){
 if(ready||!window.IPV_CONFIG?.url||!window.supabase)return;
 const {url,publishableKey}=window.IPV_CONFIG;db=window.supabase.createClient(url,publishableKey);
 const {data,error}=await db.auth.getSession();if(error||!data.session)return;
 session=data.session;const email=(session.user.email||"").toLowerCase();
 shift=email==="dependiente1@eltoque.com"?1:email==="dependiente2@eltoque.com"?2:0;
 if(!shift)return;
 ready=true;
 try{await load();}catch(e){$("closeTurnBtn").disabled=true;status(e.message||"No se pudo cargar el turno.");}
}
$("addTurnRow")?.addEventListener("click",()=>{rows.push(row());render();saveDraft();});
$("turnRows")?.addEventListener("input",e=>{
 const input=e.target.closest("[data-field]");if(!input)return;const tr=input.closest("[data-row]"),i=Number(tr.dataset.row),field=input.dataset.field;
 rows[i][field]=field==="product"?input.value:(input.value===""?0:Number(input.value));
 const c=calc(rows[i]);tr.cells[3].textContent=c.available;tr.cells[4].textContent=c.final;tr.cells[7].textContent=money(c.amount);$("turnGrandTotal").textContent=money(total());saveDraft();
});
$("closeTurnBtn")?.addEventListener("click",async()=>{
 if(working||!navigator.onLine){status("Necesitas conexión para cerrar el turno.");return;}
 if(!confirm("¿Confirmas el cierre del "+shiftLabel()+"? El cierre quedará guardado y sus existencias finales pasarán al siguiente turno."))return;
 working=true;$("closeTurnBtn").disabled=true;status("Guardando cierre en el servidor…");
 try{
  const payload=rows.filter(r=>r.product.trim()!=="").map(r=>({product:r.product.trim(),start:Number(r.start)||0,entry:Number(r.entry)||0,sold:Number(r.sold)||0,price:Number(r.price)||0}));
  if(!payload.length)throw new Error("Añade al menos un producto antes de cerrar.");
  for(const r of payload){if([r.start,r.entry,r.sold,r.price].some(n=>!Number.isFinite(n)||n<0)||r.sold>r.start+r.entry)throw new Error("Revisa "+r.product+": Vendido no puede superar Disponible y no se admiten valores negativos.");}
  const {data,error}=await db.rpc("close_worker_turn",{p_rows:payload,p_business_date:dateKey()});if(error)throw error;
  closure=data;const date=data.business_date,number=data.closure_no;$("turnDocumentNo").textContent="N°"+String(number).padStart(2,"0");
  exportData(data.rows,number,data.shift_no,date);
  localStorage.removeItem(key());
  status("Turno cerrado correctamente. Documento N°"+String(number).padStart(2,"0")+". Total: "+money(data.total)+".");
  await history();
  rows=(data.rows||[]).map(r=>row(r.product,r.final,0,0,r.price));render();
  $("closeTurnBtn").disabled=true;
 }catch(e){status("No se pudo cerrar: "+(e.message||"Error inesperado"));$("closeTurnBtn").disabled=false;}
 finally{working=false;}
});
const observer=new MutationObserver(()=>{if(!$("appPanel")?.classList.contains("hidden"))init();});
observer.observe($("appPanel"),{attributes:true,attributeFilter:["class"]});
window.addEventListener("online",init);document.addEventListener("visibilitychange",()=>{if(!document.hidden)init();});
})();