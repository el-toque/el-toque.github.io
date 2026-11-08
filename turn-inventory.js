(() => {
"use strict";
const $=id=>document.getElementById(id), money=n=>new Intl.NumberFormat("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+" CUP";
const dateKey=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let db=null,session=null,shift=0,rows=[],closure=null,ready=false,working=false,businessDate=dateKey(),sessionNo=1,independentMode=false,independentSessionId=null,canCloseTurn=true,canCountStock=true,physicalCountValues={},physicalCountConfirmed=false,physicalCountResult="";
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
 renderPhysicalCount();
}
function renderPhysicalCount(){
 const body=$("physicalCountRows");if(!body)return;
 const items=rows.filter(r=>r.product.trim()!=="");
 body.innerHTML=items.map((r,i)=>{const rowNo=i+1,expected=calc(r).final,has=Object.prototype.hasOwnProperty.call(physicalCountValues,rowNo),physical=has?physicalCountValues[rowNo]:"",difference=has&&physical!==""?Number(physical)-expected:null;return `<tr data-physical-row="${rowNo}"><td>${esc(r.product)}</td><td class="calculated">${expected}</td><td><input type="number" min="0" step="1" inputmode="numeric" data-physical-input="${rowNo}" value="${physical}" ${canCountStock?"":"disabled"} aria-label="Conteo físico de ${esc(r.product)}"></td><td class="calculated">${difference===null?"—":difference===0?"0":(difference>0?"+":"")+difference}</td></tr>`;}).join("");
 const button=$("confirmPhysicalCountBtn");if(button)button.disabled=!items.length||!canCountStock;
 const closeButton=$("closeTurnBtn");if(closeButton)closeButton.disabled=!canCloseTurn||!physicalCountConfirmed;
 const statusNode=$("physicalCountStatus");if(statusNode)statusNode.textContent=physicalCountResult||(!canCountStock?"Tu cuenta no tiene permiso para registrar el conteo físico. Solicítalo al administrador.":items.length?"Cuenta físicamente todos los productos e introduce cada cantidad, incluso cuando sea cero.":"Añade productos al IPV antes de realizar el conteo físico.");
 const badge=$("physicalCountBadge");if(badge){badge.textContent=physicalCountConfirmed?"CONTEO CONFIRMADO":"PENDIENTE DE CONTEO";badge.classList.toggle("online",physicalCountConfirmed);badge.classList.toggle("offline",!physicalCountConfirmed);}
}
function status(t){$("turnStatus").textContent=t;}
async function saveDraft(){try{localStorage.setItem(key(),JSON.stringify(rows));}catch(e){status("No se pudo guardar el borrador en este teléfono.");}}
async function persistRows(){
 physicalCountConfirmed=false;physicalCountValues={};physicalCountResult="El inventario cambió. Debes repetir y confirmar el conteo físico.";renderPhysicalCount();
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
 physicalCountValues={};physicalCountConfirmed=false;physicalCountResult="";
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
 $("closeTurnBtn").disabled=!canCloseTurn||!physicalCountConfirmed;
 status("Sesión "+sessionNo+" activa. Puedes editar las celdas habilitadas.");
 await persistRows();
 await loadPendingRequests();
 await history();
}

async function loadIndependent(){
 physicalCountValues={};physicalCountConfirmed=false;physicalCountResult="";
 const {data,error}=await db.rpc("worker_independent_get_context",{p_business_date:dateKey()});if(error)throw error;
 independentSessionId=data.session_id;businessDate=data.business_date||dateKey();sessionNo=Number(data.session_no)||1;
 window.IPV_INDEPENDENT_CONTEXT={sessionId:independentSessionId,businessDate,sessionNo,independent:true};window.IPV_TURN_CONTEXT=window.IPV_INDEPENDENT_CONTEXT;
 localStorage.setItem("ipv_turn_context_"+session.user.id,JSON.stringify(window.IPV_INDEPENDENT_CONTEXT));window.dispatchEvent(new Event("ipv:turn-context-updated"));
 rows=(data.rows||[]).map(r=>row(r.product,r.start,r.entry,r.sold,r.price));
 if(rows.length<20)rows.push(...Array.from({length:20-rows.length},()=>row()));
 closure=null;setMeta();$("addTurnRow").disabled=false;$("exportTurnXlsx").disabled=false;$("exportTurnPdf").disabled=false;
 $("turnDocumentNo").textContent="N°"+String(Number(data.last_closure_no||0)+1).padStart(2,"0");render();$("closeTurnBtn").disabled=!canCloseTurn||!physicalCountConfirmed;
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

function renderTransferProducts(){
 const host=$("ipvTransferProducts");if(!host)return;
 const items=rows.map((r,i)=>({r,i})).filter(x=>x.r.product.trim());
 host.innerHTML=items.length?'<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Disponible</th><th>Cantidad</th></tr></thead><tbody>'+items.map(({r,i})=>'<tr><td>'+esc(r.product)+'</td><td>'+calc(r).final+'</td><td><input type="number" min="0" max="'+Math.max(0,calc(r).final)+'" step="1" inputmode="numeric" data-transfer-row="'+(i+1)+'" value="0" aria-label="Cantidad de '+esc(r.product)+'"></td></tr>').join("")+'</tbody></table></div>':'<p class="muted small">No hay productos disponibles en la tabla IPV.</p>';
}
function transferStatusLabel(s){return s==="pending"?"Pendiente de recepción":s==="received"?"Recibido":"Recibido con diferencias";}
$("refreshWorkerTransfers")?.addEventListener("click",loadTransferList);
async function loadTransferList(){
 const host=$("ipvTransferList");if(!host||!db||!session||!navigator.onLine)return;
 try{
  const {data,error}=await db.rpc("worker_ipv_transfer_list");if(error)throw error;
  const list=(data||[]).map(x=>typeof x==="string"?JSON.parse(x):x);
  host.innerHTML=list.length?list.map(x=>{
   const incoming=x.sender_id!==session.user.id;
   const items=Array.isArray(x.items)?x.items:[];
   const detail=items.map(it=>'<div class="ipv-transfer-item"><span>'+esc(it.product)+'</span><strong>'+Number(it.quantity)+' uds.</strong></div>').join("");
   const receive=x.status==="pending"&&incoming;
   return '<article class="ipv-transfer-card"><div class="ipv-transfer-card-head"><strong>'+(incoming?'Recibido de ':'Enviado a ')+esc(incoming?x.sender_name:x.receiver_name)+'</strong><span class="demo-pill '+(x.status==="pending"?"offline":"online")+'">'+transferStatusLabel(x.status)+'</span></div><small class="muted">'+new Date(x.created_at).toLocaleString("es-ES")+'</small>'+detail+(receive?'<div class="ipv-transfer-receive">'+items.map((it,i)=>'<label>'+esc(it.product)+' · enviados '+Number(it.quantity)+'<input type="number" min="0" max="'+Number(it.quantity)+'" step="1" value="'+Number(it.quantity)+'" data-receive-transfer="'+esc(x.id)+'" data-receive-index="'+i+'"></label>').join("")+'<label>Observación de diferencias (opcional)<input type="text" maxlength="250" data-transfer-note="'+esc(x.id)+'" placeholder="Indica qué ocurrió"></label><button type="button" class="primary" data-confirm-transfer="'+esc(x.id)+'">Confirmar recepción</button></div>':'')+(x.discrepancy_note?'<p class="muted small">Observación: '+esc(x.discrepancy_note)+'</p>':'')+'</article>';
  }).join(""):'<p class="muted small">Todavía no hay traspasos registrados.</p>';
 }catch(e){host.innerHTML='<p class="muted small">No se pudo cargar el historial de traspasos: '+esc(e.message||"Error")+'</p>';}
}
$("ipvTransferSendBtn")?.addEventListener("click",async()=>{
 if(working||!navigator.onLine){$("ipvTransferStatus").textContent="Necesitas conexión para enviar mercancía.";return;}
 const items=[...document.querySelectorAll("[data-transfer-row]")].map(el=>({row_no:Number(el.dataset.transferRow),quantity:Number(el.value)})).filter(x=>x.quantity>0);
 if(!items.length){$("ipvTransferStatus").textContent="Selecciona al menos un producto y una cantidad.";return;}
 if(items.some(x=>!Number.isInteger(x.quantity)||x.quantity<0||x.quantity>calc(rows[x.row_no-1]).final)){$("ipvTransferStatus").textContent="Hay cantidades superiores a las existencias disponibles.";return;}
 const btn=$("ipvTransferSendBtn");btn.disabled=true;
 try{const {data,error}=await db.rpc("worker_ipv_transfer_dispatch",{p_receiver_mode:$("ipvTransferDestination").value,p_items:items});if(error)throw error;
  await load();await loadTransferList();$("ipvTransferStatus").textContent="Traspaso enviado. El receptor debe confirmar las cantidades antes de incorporarlas a su IPV.";window.dispatchEvent(new Event("ipv:turn-inventory-saved"));
 }catch(e){$("ipvTransferStatus").textContent="No se pudo enviar: "+(e.message||"Error");}finally{btn.disabled=false;renderTransferProducts();}
});
$("ipvTransferList")?.addEventListener("click",async e=>{
 const btn=e.target.closest("[data-confirm-transfer]");if(!btn)return;btn.disabled=true;
 try{
  const id=btn.dataset.confirmTransfer,inputs=[...document.querySelectorAll('[data-receive-transfer="'+id+'"]')];
  const card=btn.closest(".ipv-transfer-card"),transfer=(await db.rpc("worker_ipv_transfer_list")).data||[];
  const parsed=transfer.map(x=>typeof x==="string"?JSON.parse(x):x).find(x=>x.id===id);
  const values=inputs.map((el,i)=>({product:parsed.items[i].product,quantity:Number(el.value)}));
  if(values.some((x,i)=>!Number.isInteger(x.quantity)||x.quantity<0||x.quantity>Number(parsed.items[i].quantity)))throw new Error("Revisa las cantidades recibidas.");
  const note=card.querySelector("[data-transfer-note]")?.value||"";
  const {error}=await db.rpc("worker_ipv_transfer_receive",{p_transfer_id:id,p_received_items:values,p_note:note});if(error)throw error;
  await load();await loadTransferList();$("ipvTransferStatus").textContent="Recepción confirmada. Las cantidades recibidas ya están en tu IPV.";
 }catch(err){btn.disabled=false;$("ipvTransferStatus").textContent="No se pudo confirmar: "+(err.message||"Error");}
});

async function init(){
 if(ready||!window.IPV_CONFIG?.url||!window.supabase)return;
 const {url,publishableKey}=window.IPV_CONFIG;db=window.supabase.createClient(url,publishableKey);
 const {data,error}=await db.auth.getSession();if(error||!data.session)return;
 session=data.session;const {data:workerProfile}=await db.from("profiles").select("ipv_mode,worker_permissions").eq("id",session.user.id).maybeSingle();
 independentMode=workerProfile?.ipv_mode==="independent";if($("ipvTransferDestination")){$("ipvTransferDestination").value=independentMode?"shift":"independent";$("ipvTransferDestination").disabled=true;}canCloseTurn=workerProfile?.worker_permissions?.can_close_day!==false;canCountStock=workerProfile?.worker_permissions?.can_count_stock!==false;ready=true;const email=(session.user.email||"").toLowerCase();
 shift=email==="dependiente1@eltoque.com"?1:email==="dependiente2@eltoque.com"?2:0;
 if(!shift&&!independentMode)return;
 try{await load();renderTransferProducts();await loadTransferList();if(db.channel){db.channel("worker-entry-requests-"+session.user.id).on("postgres_changes",{event:"INSERT",schema:"public",table:independentMode?"worker_independent_entry_requests":"worker_turn_entry_requests",filter:"worker_id=eq."+session.user.id},()=>loadPendingRequests()).subscribe();db.channel("worker-ipv-transfers-"+session.user.id).on("postgres_changes",{event:"*",schema:"public",table:"ipv_transfers",filter:"receiver_id=eq."+session.user.id},()=>loadTransferList()).subscribe();}}catch(e){$("closeTurnBtn").disabled=true;$("addTurnRow").disabled=true;$("exportTurnXlsx").disabled=true;$("exportTurnPdf").disabled=true;rows=[];render();status(e.message||"No se pudo cargar el turno.");}
}
$("addTurnRow")?.addEventListener("click",()=>{rows.push(row());render();persistRows();});
$("exportTurnXlsx")?.addEventListener("click",()=>exportCurrent("xlsx"));
$("exportTurnPdf")?.addEventListener("click",()=>exportCurrent("pdf"));
$("turnRows")?.addEventListener("change",()=>{renderTransferProducts();physicalCountConfirmed=false;physicalCountResult="El inventario cambió. Debes repetir y confirmar el conteo físico.";renderPhysicalCount();persistRows();});
$("physicalCountRows")?.addEventListener("input",e=>{
 const input=e.target.closest("[data-physical-input]");if(!input)return;
 const rowNo=Number(input.dataset.physicalInput);physicalCountValues[rowNo]=input.value===""?"":Number(input.value);
 physicalCountConfirmed=false;physicalCountResult="Conteo sin confirmar. Revisa las diferencias y confirma cuando todas coincidan.";
 const tr=input.closest("tr"),item=rows.filter(r=>r.product.trim()!=="")[rowNo-1],expected=item?calc(item).final:0;
 const differenceCell=tr?.cells[3];if(differenceCell)differenceCell.textContent=input.value===""?"—":Number(input.value)-expected;
 const badge=$("physicalCountBadge");if(badge){badge.textContent="PENDIENTE DE CONFIRMACIÓN";badge.classList.remove("online");badge.classList.add("offline");}
 const statusNode=$("physicalCountStatus");if(statusNode)statusNode.textContent=physicalCountResult;
});
$("confirmPhysicalCountBtn")?.addEventListener("click",async()=>{
 if(!canCountStock){status("Tu cuenta no tiene permiso para registrar el conteo físico. Solicítalo al administrador.");return;}
 if(working||!navigator.onLine){status("Necesitas conexión para guardar y confirmar el conteo físico.");return;}
 const items=rows.filter(r=>r.product.trim()!=="");if(!items.length){status("No hay productos para contar.");return;}
 const countRows=items.map((r,i)=>({row_no:i+1,product:r.product.trim(),physical_qty:physicalCountValues[i+1]}));
 if(countRows.some(x=>!Number.isInteger(x.physical_qty)||x.physical_qty<0)){physicalCountConfirmed=false;physicalCountResult="Completa una cantidad física entera para cada producto, incluidos los ceros.";renderPhysicalCount();return;}
 working=true;const btn=$("confirmPhysicalCountBtn");btn.disabled=true;btn.textContent="Verificando…";
 try{
  const inventoryPayload=items.map(r=>({product:r.product.trim(),start:Number(r.start)||0,entry:Number(r.entry)||0,sold:Number(r.sold)||0,price:Number(r.price)||0}));
  const saved=independentMode?await db.rpc("worker_independent_save_inventory",{p_session_id:independentSessionId,p_rows:inventoryPayload}):await db.rpc("worker_save_turn_inventory",{p_rows:inventoryPayload,p_business_date:businessDate,p_session_no:sessionNo});
  if(saved.error)throw saved.error;
  const {data,error}=await db.rpc("worker_save_physical_inventory_count",{p_business_date:businessDate,p_session_no:sessionNo,p_session_id:independentMode?independentSessionId:null,p_rows:countRows});
  if(error)throw error;
  physicalCountConfirmed=!!data?.matches;
  physicalCountResult=physicalCountConfirmed?"Conteo físico confirmado: todas las existencias coinciden exactamente con el final del IPV.":"Se encontraron "+Number(data?.differences||0)+" diferencia(s). El turno no podrá cerrarse hasta corregir el conteo y lograr que coincida con el IPV.";
  renderPhysicalCount();status(physicalCountResult);
 }catch(e){physicalCountConfirmed=false;physicalCountResult="No se pudo confirmar el conteo: "+(e.message||"Error inesperado");renderPhysicalCount();status(physicalCountResult);}
 finally{working=false;btn.disabled=false;btn.textContent="Verificar y confirmar conteo físico";}
});
$("turnRows")?.addEventListener("input",e=>{
 const input=e.target.closest("[data-field]");if(!input)return;const tr=input.closest("[data-row]"),i=Number(tr.dataset.row),field=input.dataset.field;
 rows[i][field]=field==="product"?input.value:(input.value===""?0:Number(input.value));
 physicalCountConfirmed=false;physicalCountValues={};physicalCountResult="El inventario cambió. Debes repetir el conteo físico.";renderPhysicalCount();
 const c=calc(rows[i]);tr.cells[3].textContent=c.available;tr.cells[4].textContent=c.final;tr.cells[7].textContent=money(c.amount);$("turnGrandTotal").textContent=money(total());saveDraft();
});
$("closeTurnBtn")?.addEventListener("click",async()=>{
 if(!physicalCountConfirmed){status("No puedes cerrar el IPV ni entregar el inventario: primero realiza y confirma el conteo físico de todos los productos sin diferencias.");return;}
 if(working||!navigator.onLine){status("Necesitas conexión para cerrar el turno.");return;}if(!canCloseTurn){status("Tu cuenta no tiene permiso para cerrar la jornada. Solicítalo al administrador.");return;}
 if(typeof window.getIPVPendingSalesCount==="function"){const pending=await window.getIPVPendingSalesCount();if(pending===null){status("No se pudo comprobar la cola de ventas pendientes. Sincroniza y vuelve a intentarlo.");return;}if(pending>0){status("Tienes "+pending+" venta(s) pendiente(s) de sincronizar. Sincronízalas antes de cerrar el IPV.");return;}}
 if(!confirm("¿Confirmas el cierre del "+shiftLabel()+"? El cierre quedará guardado y sus existencias finales pasarán al siguiente turno."))return;
 working=true;$("closeTurnBtn").disabled=true;status("Guardando cierre en el servidor…");
 try{
  const payload=rows.filter(r=>r.product.trim()!=="").map(r=>({product:r.product.trim(),start:Number(r.start)||0,entry:Number(r.entry)||0,sold:Number(r.sold)||0,price:Number(r.price)||0}));
  const {error:syncError}=independentMode?await db.rpc("worker_independent_save_inventory",{p_session_id:independentSessionId,p_rows:payload}):await db.rpc("worker_save_turn_inventory",{p_rows:payload,p_business_date:businessDate,p_session_no:sessionNo});if(syncError)throw syncError;
  if(!payload.length)throw new Error("Añade al menos un producto antes de cerrar.");
  for(const r of payload){if([r.start,r.entry,r.sold,r.price].some(n=>!Number.isFinite(n)||n<0)||r.sold>r.start+r.entry)throw new Error("Revisa "+r.product+": Vendido no puede superar Disponible y no se admiten valores negativos.");}
  const billCounts={};document.querySelectorAll("#dailyBillsBody [data-bill-denomination]").forEach(el=>{const n=Number(el.value);if(!Number.isInteger(n)||n<0)throw new Error("Completa el conteo de billetes de todas las denominaciones.");billCounts[el.dataset.billDenomination]=n;});if(Object.keys(billCounts).length!==denominations.length)throw new Error("El conteo de billetes debe incluir todas las denominaciones.");const {data,error}=independentMode?await db.rpc("worker_independent_close",{p_session_id:independentSessionId,p_rows:payload,p_bill_counts:billCounts}):await db.rpc("close_worker_turn",{p_rows:payload,p_business_date:businessDate,p_session_no:sessionNo,p_bill_counts:billCounts});if(error)throw error;
  closure=data;physicalCountConfirmed=false;physicalCountValues={};physicalCountResult="";const date=data.business_date,number=independentMode?data.session_no:data.closure_no;$("turnDocumentNo").textContent="N°"+String(number).padStart(2,"0");
  await exportData(data.rows,number,data.shift_no||0,date,"both",true);
  localStorage.removeItem(key());
  status("Turno cerrado correctamente. Documento N°"+String(number).padStart(2,"0")+". Total: "+money(data.total)+".");
  await history();
  if(independentMode){localStorage.removeItem(key());await loadIndependent();}else{rows=(data.rows||[]).map(r=>row(r.product,r.final,0,0,r.price));render();$("closeTurnBtn").disabled=true;}
 }catch(e){status("No se pudo cerrar: "+(e.message||"Error inesperado"));$("closeTurnBtn").disabled=!canCloseTurn||!physicalCountConfirmed;}
 finally{working=false;}
});
const observer=new MutationObserver(()=>{if($("appPanel")?.classList.contains("hidden")){ready=false;session=null;shift=0;rows=[];}else init();});
observer.observe($("appPanel"),{attributes:true,attributeFilter:["class"]});
window.refreshWorkerTurnInventory=async function(){if(!session||!navigator.onLine)return false;try{if(independentMode){await loadIndependent();return true;}const {data,error}=await db.rpc("worker_get_turn_inventory_v2",{p_business_date:businessDate,p_session_no:sessionNo});if(error)throw error;if(Array.isArray(data)){rows=data.map(x=>row(x.product_name,x.start_qty,x.entry_qty,x.sold_qty,x.price));if(rows.length<20)rows.push(...Array.from({length:20-rows.length},()=>row()));render();await saveDraft();return true;}return false;}catch(e){status("No se pudo actualizar la tabla tras la venta: "+e.message);return false;}};window.addEventListener("online",()=>{ready=false;init();});
window.addEventListener("ipv:turn-inventory-refresh",()=>window.refreshWorkerTurnInventory?.());document.addEventListener("visibilitychange",()=>{if(!document.hidden)init();});
})();