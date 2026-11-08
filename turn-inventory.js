(() => {
"use strict";
const $=id=>document.getElementById(id), money=n=>new Intl.NumberFormat("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+" CUP";
const dateKey=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let db=null,session=null,shift=0,rows=[],closure=null,ready=false,working=false,businessDate=dateKey(),sessionNo=1,independentMode=false,independentSessionId=null,canCloseTurn=true;
const denominations=[5000,2000,1000,500,200,100,50,20,10,5,3,1];
const key=()=> "ipv_turn_draft_"+session.user.id+"_"+businessDate+"_"+shift+"_"+sessionNo;
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
 <td class="calculated sold" aria-label="Vendido protegido">${r.sold}</td>
 <td><input data-field="price" type="number" min="0" step="0.01" inputmode="decimal" value="${r.price}"></td>
 <td class="calculated amount">${money(c.amount)}</td>
 </tr>`;}).join("");
 $("turnGrandTotal").textContent=money(total());
 $("turnRowsCount").textContent=rows.length+" filas";
}
function status(t){$("turnStatus").textContent=t;}
async function saveDraft(){try{localStorage.setItem(key(),JSON.stringify(rows));}catch(e){status("No se pudo guardar el borrador en este teléfono.");}}
async function persistRows(){
 await saveDraft();
 if(!navigator.onLine||!db||!session)return;
 const payload=rows.filter(r=>r.product.trim()!=="").map(r=>({product:r.product.trim(),start:Number(r.start)||0,entry:Number(r.entry)||0,sold:Number(r.sold)||0,price:Number(r.price)||0}));
 const {error}=independentMode?await db.rpc("worker_independent_save_inventory",{p_session_id:independentSessionId,p_rows:payload}):await db.rpc("worker_save_turn_inventory",{p_rows:payload,p_business_date:businessDate,p_session_no:sessionNo});
 if(error)status("No se pudo sincronizar la tabla: "+error.message);
 else{status("Tabla guardada y sincronizada con la tienda.");window.dispatchEvent(new Event("ipv:turn-inventory-saved"));}
}
function shiftLabel(){return independentMode?"IPV Independiente":(shift===1?"Turno 1":"Turno 2");}
async function exportCurrent(format){
 if(!session||(!shift&&!independentMode)||!rows.length){status("No hay datos del turno para exportar.");return;}
 const savedRows=rows.filter(r=>r.product.trim()!=="").map(r=>{const c=calc(r);return {product:r.product,start:Number(r.start)||0,entry:Number(r.entry)||0,available:c.available,final:c.final,sold:Number(r.sold)||0,price:Number(r.price)||0,amount:c.amount};});
 if(!savedRows.length){status("Añade al menos un producto antes de exportar.");return;}
 const match=($("turnDocumentNo").textContent.match(/\d+/)||[])[0]||"01";
 await exportData(savedRows,Number(match),shift,businessDate,format,false);
 status(format==="xlsx"?"Archivo Excel preparado.":"Archivo PDF preparado.");
}
function setMeta(){ const d=new Date(businessDate+"T12:00:00"); $("turnShift").textContent=shiftLabel();$("turnDate").textContent=d.toLocaleDateString("es-ES",{weekday:"long",year:"numeric",month:"long",day:"numeric"}); }
async function load(){
 if(independentMode)return loadIndependent();
 const day=dateKey();
 const {data:last,error}=await db.rpc("get_last_worker_turn_v2",{p_business_date:day});
 if(error)throw error;
 if(!last?.is_my_turn)throw new Error("Turno en espera. El otro trabajador debe cerrar y entregar sus existencias antes de que puedas iniciar tu sesión.");

 businessDate=last.last_business_date||last.business_date||day;sessionNo=Number(last.session_no)||1;
 window.IPV_TURN_CONTEXT={businessDate,sessionNo,shift};
 localStorage.setItem("ipv_turn_context_"+session.user.id,JSON.stringify(window.IPV_TURN_CONTEXT));
 window.dispatchEvent(new Event("ipv:turn-context-updated"));
 rows=(last.last_rows||[]).map(r=>row(r.product,r.final,0,0,r.price));
 if(!rows.length)rows=Array.from({length:20},()=>row());
 if(navigator.onLine){
  const {data:live,error:liveError}=await db.rpc("worker_get_turn_inventory_v2",{p_business_date:businessDate,p_session_no:sessionNo});
  if(liveError)throw liveError;
  if(Array.isArray(live)&&live.length)rows=live.map(x=>row(x.product_name,x.start_qty,x.entry_qty,x.sold_qty,x.price));
 }
 const saved=localStorage.getItem(key());
 if(!rows.some(r=>r.product.trim())&&saved){try{const draft=JSON.parse(saved);if(Array.isArray(draft)&&draft.length)rows=draft;}catch(_){}}
 if(rows.length<20)rows.push(...Array.from({length:20-rows.length},()=>row()));
 closure=null;setMeta();$("addTurnRow").disabled=false;$("exportTurnXlsx").disabled=false;$("exportTurnPdf").disabled=false;$("turnDocumentNo").textContent="N°"+String((last.last_closure_no||0)+1).padStart(2,"0");render();
 $("closeTurnBtn").disabled=!canCloseTurn;
 status("Sesión "+sessionNo+" activa. Puedes editar las celdas habilitadas.");
 await persistRows();
 await loadPendingRequests();
 await history();
}

async function loadIndependent(){
 const {data,error}=await db.rpc("worker_independent_get_context",{p_business_date:dateKey()});if(error)throw error;
 independentSessionId=data.session_id;businessDate=data.business_date||dateKey();sessionNo=Number(data.session_no)||1;
 window.IPV_INDEPENDENT_CONTEXT={sessionId:independentSessionId,businessDate,sessionNo,independent:true};window.IPV_TURN_CONTEXT=window.IPV_INDEPENDENT_CONTEXT;
 localStorage.setItem("ipv_turn_context_"+session.user.id,JSON.stringify(window.IPV_INDEPENDENT_CONTEXT));window.dispatchEvent(new Event("ipv:turn-context-updated"));
 rows=(data.rows||[]).map(r=>row(r.product,r.start,r.entry,r.sold,r.price));
 if(rows.length<20)rows.push(...Array.from({length:20-rows.length},()=>row()));
 closure=null;setMeta();$("addTurnRow").disabled=false;$("exportTurnXlsx").disabled=false;$("exportTurnPdf").disabled=false;
 $("turnDocumentNo").textContent="N°"+String(Number(data.last_closure_no||0)+1).padStart(2,"0");render();$("closeTurnBtn").disabled=!canCloseTurn;
 status("Jornada independiente "+sessionNo+" activa. Puedes cerrarla cuando decidas, sin límite de horas.");
 await persistRows();await loadPendingRequests();await history();
}
async function loadPendingRequests(){
 const host=$("turnPendingRequests");if(!host||!db||!session||!navigator.onLine)return;
 try{
  const {data,error}=independentMode?await db.rpc("worker_independent_list_entry_requests",{p_session_id:independentSessionId}):await db.rpc("worker_list_entry_requests",{p_business_date:businessDate,p_session_no:sessionNo});
  if(error)throw error;
  const list=data||[];
  host.innerHTML=list.length?list.map(x=>'<div class="turn-pending-row"><div><strong>'+esc(x.product_name)+'</strong><span>'+Number(x.quantity)+' unidades'+(Number(x.price)>0?' · '+money(x.price):'')+'</span></div><button type="button" class="primary" data-approve-entry="'+x.id+'">Aceptar</button></div>').join(''):'<p class="muted small">No tienes entradas pendientes.</p>';
 }catch(e){host.innerHTML='<p class="muted small">No se pudieron consultar las entradas pendientes: '+esc(e.message||"Error")+'</p>';}
}
$("turnPendingRequests")?.addEventListener("click",async e=>{
 const button=e.target.closest("[data-approve-entry]");if(!button||working)return;
 button.disabled=true;
 try{
  const {error}=independentMode?await db.rpc("worker_independent_approve_entry_request",{p_request_id:button.dataset.approveEntry,p_session_id:independentSessionId}):await db.rpc("worker_approve_entry_request",{p_request_id:button.dataset.approveEntry,p_business_date:businessDate,p_session_no:sessionNo});
  if(error)throw error;
  await window.refreshWorkerTurnInventory?.();
  await loadPendingRequests();
  status("Entrada aprobada. La cantidad ya está incluida en tu IPV.");
  window.dispatchEvent(new Event("ipv:turn-inventory-saved"));
 }catch(error){button.disabled=false;status("No se pudo aprobar la entrada: "+(error.message||"Error inesperado"));}
});

async function history(){
 const result=independentMode?await db.from("worker_independent_closures").select("id,session_no,business_date,total,created_at").eq("worker_id",session.user.id).order("session_no",{ascending:false}).limit(12):await db.from("worker_turn_closures").select("closure_no,shift_no,business_date,total,created_at").eq("worker_id",session.user.id).order("closure_no",{ascending:false}).limit(12);
 const {data,error}=result;if(error){$("turnHistory").innerHTML="<p>No se pudo cargar el historial.</p>";return;}
 $("turnHistory").innerHTML=(data||[]).map(x=>"<div class=\"turn-history-row\"><strong>N°"+String(independentMode?x.session_no:x.closure_no).padStart(2,"0")+" · "+(independentMode?"IPV Independiente":"Turno "+x.shift_no)+"</strong><span>"+esc(x.business_date)+" · "+money(x.total)+"</span></div>").join("")||"<p class=\"muted small\">Todavía no hay turnos cerrados.</p>";
}
async function exportData(savedRows,number,shiftNo,date,format="both",archive=false){
 const billCounts={};document.querySelectorAll("#dailyBillsBody [data-bill-denomination]").forEach(el=>billCounts[el.dataset.billDenomination]=Number(el.value)||0);
 const bills=denominations.filter(v=>billCounts[v]>0).map(v=>({"Denominación":v+" CUP","Cantidad de billetes":billCounts[v],"Importe":v*billCounts[v]}));
 const billTotal=denominations.reduce((n,v)=>n+v*(billCounts[v]||0),0);
 bills.push({"Denominación":"TOTAL EFECTIVO CONTADO","Cantidad de billetes":denominations.reduce((n,v)=>n+(billCounts[v]||0),0),"Importe":billTotal});
 const base=(independentMode?"independent-":"turn-"+shiftNo+"-")+sessionNo+"-"+date;
 if((format==="xlsx"||format==="both")&&window.XLSX){
  const data=savedRows.map(r=>({Producto:r.product,Inicio:r.start,Entrada:r.entry,Disponible:r.available,Final:r.final,Vendido:r.sold,Precio:r.price,Importe:r.amount}));
  data.push({Producto:"TOTAL GENERAL",Inicio:"",Entrada:"",Disponible:"",Final:"",Vendido:"",Precio:"",Importe:savedRows.reduce((n,r)=>n+r.amount,0)});
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([{Cuenta:session.user.user_metadata?.full_name||session.user.email,Correo:session.user.email,Turno:shiftLabel(),Documento:"N°"+String(number).padStart(2,"0"),Fecha:date,Total:money(savedRows.reduce((n,r)=>n+r.amount,0))}]),"Datos");
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),"IPV");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(bills),"Conteo de billetes");
  if(archive){const bytes=XLSX.write(wb,{bookType:"xlsx",type:"array"});const blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});const path="workers/"+session.user.id+"/"+base+".xlsx";const {error}=await db.storage.from("ipv-archives").upload(path,blob,{upsert:true,contentType:blob.type});if(error)status("Cierre guardado, pero no se pudo archivar el Excel: "+error.message);}
  XLSX.writeFile(wb,(independentMode?"IPV_Independiente_":"IPV_Turno_")+number+"_"+date+".xlsx");
 }
 if((format==="pdf"||format==="both")&&window.jspdf?.jsPDF){
  const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
  doc.setFontSize(16);doc.text("IPV Digital · "+shiftLabel()+" · N°"+String(number).padStart(2,"0"),14,14);doc.setFontSize(9);
  doc.text("Cuenta: "+(session.user.user_metadata?.full_name||session.user.email),14,20);doc.text("Correo: "+session.user.email+" · Fecha: "+date,14,25);
  const tableRows=savedRows.map(r=>[r.product,r.start,r.entry,r.available,r.final,r.sold,r.price.toFixed(2),r.amount.toFixed(2)]);
  tableRows.push(["","","","","","","TOTAL",savedRows.reduce((n,r)=>n+r.amount,0).toFixed(2)]);
  doc.autoTable({startY:30,head:[["Producto","Inicio","Entrada","Disponible","Final","Vendido","Precio","Importe"]],body:tableRows,styles:{fontSize:8},headStyles:{fillColor:[45,38,24]}});
  doc.autoTable({startY:doc.lastAutoTable.finalY+8,head:[["Denominación","Cantidad","Importe"]],body:bills.map(b=>[b["Denominación"],b["Cantidad de billetes"],b.Importe.toFixed(2)]),styles:{fontSize:8}});
  if(archive){const blob=doc.output("blob");const path="workers/"+session.user.id+"/"+base+".pdf";const {error}=await db.storage.from("ipv-archives").upload(path,blob,{upsert:true,contentType:"application/pdf"});if(error)status("Cierre guardado, pero no se pudo archivar el PDF: "+error.message);}
  doc.save((independentMode?"IPV_Independiente_":"IPV_Turno_")+number+"_"+date+".pdf");
 }
}
async function init(){
 if(ready||!window.IPV_CONFIG?.url||!window.supabase)return;
 const {url,publishableKey}=window.IPV_CONFIG;db=window.supabase.createClient(url,publishableKey);
 const {data,error}=await db.auth.getSession();if(error||!data.session)return;
 session=data.session;const {data:workerProfile}=await db.from("profiles").select("ipv_mode,worker_permissions").eq("id",session.user.id).maybeSingle();
 independentMode=workerProfile?.ipv_mode==="independent";canCloseTurn=workerProfile?.worker_permissions?.can_close_day!==false;ready=true;const email=(session.user.email||"").toLowerCase();
 shift=email==="dependiente1@eltoque.com"?1:email==="dependiente2@eltoque.com"?2:0;
 if(!shift&&!independentMode)return;
 try{await load();if(db.channel){db.channel("worker-entry-requests-"+session.user.id).on("postgres_changes",{event:"INSERT",schema:"public",table:independentMode?"worker_independent_entry_requests":"worker_turn_entry_requests",filter:"worker_id=eq."+session.user.id},()=>loadPendingRequests()).subscribe();}}catch(e){$("closeTurnBtn").disabled=true;$("addTurnRow").disabled=true;$("exportTurnXlsx").disabled=true;$("exportTurnPdf").disabled=true;rows=[];render();status(e.message||"No se pudo cargar el turno.");}
}
$("addTurnRow")?.addEventListener("click",()=>{rows.push(row());render();persistRows();});
$("exportTurnXlsx")?.addEventListener("click",()=>exportCurrent("xlsx"));
$("exportTurnPdf")?.addEventListener("click",()=>exportCurrent("pdf"));
$("turnRows")?.addEventListener("change",()=>persistRows());
$("turnRows")?.addEventListener("input",e=>{
 const input=e.target.closest("[data-field]");if(!input)return;const tr=input.closest("[data-row]"),i=Number(tr.dataset.row),field=input.dataset.field;
 rows[i][field]=field==="product"?input.value:(input.value===""?0:Number(input.value));
 const c=calc(rows[i]);tr.cells[3].textContent=c.available;tr.cells[4].textContent=c.final;tr.cells[7].textContent=money(c.amount);$("turnGrandTotal").textContent=money(total());saveDraft();
});
$("closeTurnBtn")?.addEventListener("click",async()=>{
 if(working||!navigator.onLine){status("Necesitas conexión para cerrar el turno.");return;}if(!canCloseTurn){status("Tu cuenta no tiene permiso para cerrar la jornada. Solicítalo al administrador.");return;}
 if(!confirm("¿Confirmas el cierre del "+shiftLabel()+"? El cierre quedará guardado y sus existencias finales pasarán al siguiente turno."))return;
 working=true;$("closeTurnBtn").disabled=true;status("Guardando cierre en el servidor…");
 try{
  const payload=rows.filter(r=>r.product.trim()!=="").map(r=>({product:r.product.trim(),start:Number(r.start)||0,entry:Number(r.entry)||0,sold:Number(r.sold)||0,price:Number(r.price)||0}));
  const {error:syncError}=independentMode?await db.rpc("worker_independent_save_inventory",{p_session_id:independentSessionId,p_rows:payload}):await db.rpc("worker_save_turn_inventory",{p_rows:payload,p_business_date:businessDate,p_session_no:sessionNo});if(syncError)throw syncError;
  if(!payload.length)throw new Error("Añade al menos un producto antes de cerrar.");
  for(const r of payload){if([r.start,r.entry,r.sold,r.price].some(n=>!Number.isFinite(n)||n<0)||r.sold>r.start+r.entry)throw new Error("Revisa "+r.product+": Vendido no puede superar Disponible y no se admiten valores negativos.");}
  const billCounts={};document.querySelectorAll("#dailyBillsBody [data-bill-denomination]").forEach(el=>{const n=Number(el.value);if(!Number.isInteger(n)||n<0)throw new Error("Completa el conteo de billetes de todas las denominaciones.");billCounts[el.dataset.billDenomination]=n;});if(Object.keys(billCounts).length!==denominations.length)throw new Error("El conteo de billetes debe incluir todas las denominaciones.");const {data,error}=independentMode?await db.rpc("worker_independent_close",{p_session_id:independentSessionId,p_rows:payload,p_bill_counts:billCounts}):await db.rpc("close_worker_turn",{p_rows:payload,p_business_date:businessDate,p_session_no:sessionNo,p_bill_counts:billCounts});if(error)throw error;
  closure=data;const date=data.business_date,number=independentMode?data.session_no:data.closure_no;$("turnDocumentNo").textContent="N°"+String(number).padStart(2,"0");
  await exportData(data.rows,number,data.shift_no||0,date,"both",true);
  localStorage.removeItem(key());
  status("Turno cerrado correctamente. Documento N°"+String(number).padStart(2,"0")+". Total: "+money(data.total)+".");
  await history();
  if(independentMode){localStorage.removeItem(key());await loadIndependent();}else{rows=(data.rows||[]).map(r=>row(r.product,r.final,0,0,r.price));render();$("closeTurnBtn").disabled=true;}
 }catch(e){status("No se pudo cerrar: "+(e.message||"Error inesperado"));$("closeTurnBtn").disabled=!canCloseTurn;}
 finally{working=false;}
});
const observer=new MutationObserver(()=>{if($("appPanel")?.classList.contains("hidden")){ready=false;session=null;shift=0;rows=[];}else init();});
observer.observe($("appPanel"),{attributes:true,attributeFilter:["class"]});
window.refreshWorkerTurnInventory=async function(){if(!session||!navigator.onLine)return false;try{if(independentMode){await loadIndependent();return true;}const {data,error}=await db.rpc("worker_get_turn_inventory_v2",{p_business_date:businessDate,p_session_no:sessionNo});if(error)throw error;if(Array.isArray(data)){rows=data.map(x=>row(x.product_name,x.start_qty,x.entry_qty,x.sold_qty,x.price));if(rows.length<20)rows.push(...Array.from({length:20-rows.length},()=>row()));render();await saveDraft();return true;}return false;}catch(e){status("No se pudo actualizar la tabla tras la venta: "+e.message);return false;}};window.addEventListener("online",()=>{ready=false;init();});
window.addEventListener("ipv:turn-inventory-refresh",()=>window.refreshWorkerTurnInventory?.());document.addEventListener("visibilitychange",()=>{if(!document.hidden)init();});
})();