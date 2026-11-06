(() => {
"use strict";
const cfg=window.IPV_CONFIG||{};
const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+" CUP";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let client=null,initPromise=null,user=null,profile=null,loginInProgress=false,products=[],cart=[],categories=[],shopCategory="all",workerAllocations=[];let adminIPVTarget=null;
// Almacenamiento local duradero para sesión de trabajador, catálogo y ventas pendientes.
const OFFLINE_DB="ipv_digital_offline_v1";
function offlineDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(OFFLINE_DB,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains("records"))db.createObjectStore("records");};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function localGet(key){const db=await offlineDB();return new Promise((resolve,reject)=>{const tx=db.transaction("records","readonly"),r=tx.objectStore("records").get(key);r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error);});}
async function localPut(key,value){const db=await offlineDB();return new Promise((resolve,reject)=>{const tx=db.transaction("records","readwrite");tx.objectStore("records").put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function localDelete(key){const db=await offlineDB();return new Promise((resolve,reject)=>{const tx=db.transaction("records","readwrite");tx.objectStore("records").delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function pendingSales(){return (await localGet("pending_sales"))||[];}
async function updatePendingBadge(){const queue=await pendingSales(),n=queue.length;const status=$("offlineStatus");if(status){status.textContent=n?`${n} venta(s) pendiente(s) de sincronizar`:(navigator.onLine?"EN LÍNEA":"SIN CONEXIÓN");status.classList.toggle("pending",n>0);status.classList.toggle("offline",!navigator.onLine);status.classList.toggle("online",navigator.onLine&&n===0);}const syncBtn=$("syncPendingBtn");if(syncBtn){syncBtn.classList.toggle("hidden",n===0);syncBtn.disabled=!navigator.onLine||syncingPending;syncBtn.textContent=syncingPending?"Sincronizando…":"Sincronizar ventas pendientes";}const close=$("closeDaily");if(close){const pendingCounts=workerPermission("can_count_stock")&&Array.isArray(dailyStockRows)?dailyStockRows.filter(x=>x.physical===null).length:0;close.disabled=!!activeCloseout||n>0||!navigator.onLine||pendingCounts>0||!workerPermission("can_close_day")||!workerPermission("can_view_own_closeout");close.title=n?"Sincroniza las ventas pendientes antes de cerrar":pendingCounts?"Completa el conteo físico de todos los productos antes de cerrar":"";}for(const id of ["exportDaily","exportDailyPdf","refreshDaily"]){const b=$(id);if(b){b.disabled=!navigator.onLine;b.title=navigator.onLine?"":"Necesitas conexión para consultar el cuadre actualizado";}}return n;}
async function saveOfflineSale(items,method,code,id=crypto.randomUUID()){
 const queue=await pendingSales();
 if(queue.some(x=>x.id===id))return queue.find(x=>x.id===id);
 // Evita consumir dos veces las mismas unidades asignadas mientras no hay servidor.
 for(const line of items){const allocation=workerAllocations.find(a=>a.product_id===line.product_id);if(!allocation||Number(allocation.quantity_remaining)<Number(line.quantity))throw new Error("Existencia local insuficiente para completar la venta.");}
 const turnCtx=navigator.onLine?await ensureTurnContext():(window.IPV_TURN_CONTEXT||JSON.parse(localStorage.getItem("ipv_turn_context_"+user.id)||"null"));
 if(!turnCtx)throw new Error("No se pudo identificar la sesión activa para guardar la venta sin conexión.");
 const entry={id,worker_id:user?.id||null,turn_inventory:true,session_no:turnCtx.sessionNo,items:items.map(x=>({product_id:x.product_id,quantity:x.quantity})),payment_method:method,transfer_code:method==="transfer"?code:null,business_date:turnCtx.businessDate,created_at:new Date().toISOString(),status:"pending"};
 queue.push(entry);await localPut("pending_sales",queue);
 for(const line of entry.items){const allocation=workerAllocations.find(a=>a.product_id===line.product_id);allocation.quantity_remaining-=line.quantity;}
 await cacheWorkerState();await updatePendingBadge();renderShopProducts();return entry;
}
let syncingPending=false;
$("syncPendingBtn").addEventListener("click",syncPendingSales);
async function syncPendingSales(){
 if(syncingPending||!navigator.onLine||!client||!user||admin())return;
 syncingPending=true;
 try{
  let queue=await pendingSales();if(!queue.length){await updatePendingBadge();return;}
  for(const entry of [...queue]){
   if(!navigator.onLine)break;
   if(entry.worker_id&&entry.worker_id!==user.id){toast("Hay ventas pendientes de otra cuenta. Entra con la cuenta que las registró para sincronizarlas.");break;}
   const {data,error}=entry.turn_inventory
    ? await client.rpc("worker_turn_create_sale",{p_items:entry.items.map(x=>({turn_item_id:x.product_id,quantity:x.quantity})),p_payment_method:entry.payment_method,p_idempotency_key:entry.id,p_transfer_code:entry.transfer_code,p_business_date:entry.business_date,p_session_no:Number(entry.session_no)||1})
    : await client.rpc("create_sale",{p_items:entry.items,p_payment_method:entry.payment_method,p_idempotency_key:entry.id,p_notes:null,p_transfer_code:entry.transfer_code,p_business_date:entry.business_date});
   if(error){entry.last_error=error.message;entry.status="error";queue=queue.map(x=>x.id===entry.id?entry:x);await localPut("pending_sales",queue);toast("Una venta sigue pendiente: "+error.message);break;}
   queue=queue.filter(x=>x.id!==entry.id);await localPut("pending_sales",queue);if(entry.turn_inventory)window.dispatchEvent(new Event("ipv:turn-inventory-refresh"));toast("Venta pendiente sincronizada. Folio: "+data);
  }
  await updatePendingBadge();
  if(!(await pendingSales()).length){await loadProducts();await loadWorkerAllocations();await loadDailySales();}
 }catch(e){toast("No se pudo completar la sincronización. Las ventas siguen guardadas en este teléfono.");}
 finally{syncingPending=false;await updatePendingBadge();}
}
async function cacheWorkerState(){if(!user||!profile||admin())return;await localPut("worker_profile_"+user.id,profile);await localPut("worker_snapshot_"+user.id,{products,categories,workerAllocations,saved_at:new Date().toISOString()});}
const toast=msg=>{const el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)};
const admin=()=>profile?.role==="admin";
const workerPermission=key=>admin()||profile?.worker_permissions?.[key]!==false;
function fail(el,msg){$(el).textContent=msg}
async function init(){
 if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js?v=42",{updateViaCache:"none"}).then(reg=>reg.update()).catch(()=>{});
 window.addEventListener("online",()=>{syncPendingSales();});window.addEventListener("offline",()=>{updatePendingBadge();});
 if(!cfg.url||!cfg.publishableKey){$("sessionLabel").textContent="CONFIGURACIÓN PENDIENTE";document.body.classList.add("login-screen");$("loginPanel").classList.remove("hidden");fail("loginError","Falta configurar config.js con la URL y la clave publicable del proyecto.");return}
 try{
  client=window.supabase.createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  client.auth.onAuthStateChange((event,session)=>{if(event==="SIGNED_OUT"&&!session&&!loginInProgress&&user){showLogin();fail("loginError","La sesión se cerró. Vuelve a iniciar sesión.");}});
  // Recuperar la sesión persistida en el teléfono al recargar la página.
  $("sessionLabel").textContent="RECUPERANDO SESIÓN…";
  const {data:authState,error:sessionError}=await client.auth.getSession();
  if(sessionError)throw sessionError;
  if(authState?.session?.user){
   loginInProgress=true;
   try{await enter(authState.session.user);}
   finally{loginInProgress=false;}
  }else{
   showLogin();
   $("sessionLabel").textContent="LISTO PARA ACCEDER";
  }
 }catch(error){showLogin();fail("loginError","No se pudo preparar el acceso: "+(error?.message||"Error inesperado")+". Recarga la página e inténtalo de nuevo.");}
}
function showLogin(){user=null;profile=null;document.body.classList.add("login-screen");document.body.classList.remove("admin-mode","admin-sidebar-open");$("adminSidebarOverlay")?.classList.add("hidden");$("adminMenuToggle")?.classList.add("hidden");$("appPanel").classList.add("hidden");$("loginPanel").classList.remove("hidden");$("sessionLabel").textContent="SIN SESIÓN"}
async function enter(authUser){
 user=authUser;
 let data=null,error=null;
 if(!navigator.onLine){const cached=await localGet("worker_profile_"+user.id),snapshot=await localGet("worker_snapshot_"+user.id);if(cached?.active&&cached.role==="worker"&&snapshot){profile=cached;products=snapshot.products||[];categories=snapshot.categories||[];workerAllocations=snapshot.workerAllocations||[];renderCategoryControls();renderProducts();renderShopProducts();data=cached;}else{showLogin();fail("loginError","Para entrar sin conexión debes haber iniciado sesión antes en este teléfono y tener el catálogo guardado.");return;}}
 else ({data,error}=await client.from("profiles").select("full_name,role,active,worker_permissions").eq("id",user.id).single());
 if(navigator.onLine&&(error||!data||!data.active)){const detail=error?.message||(!data?"No se encontró el perfil de este usuario.":"El perfil está desactivado.");throw new Error("No se pudo cargar el perfil: "+detail);}
 if(navigator.onLine){profile=data;if(!admin())await localPut("worker_profile_"+user.id,data);}
 if(!navigator.onLine&&profile?.role!=="worker"){showLogin();fail("loginError","La administración requiere conexión a internet.");return;}
 data=profile;
 document.body.classList.toggle("admin-mode",data.role!=="worker");$("adminSidebar")?.classList.toggle("hidden",data.role==="worker");document.body.classList.remove("admin-sidebar-open");$("adminSidebarOverlay")?.classList.add("hidden");$("adminMenuToggle")?.classList.toggle("hidden",data.role==="worker");
 document.body.classList.remove("login-screen");$("loginPanel").classList.add("hidden");$("appPanel").classList.remove("hidden");$("sessionLabel").textContent=admin()?"ADMINISTRADOR":"TRABAJADOR";$("welcome").textContent=`Hola, ${data.full_name||user.email} · ${data.role}`;
 $("addBtn").classList.toggle("hidden",!admin());$("exportInventory").classList.toggle("hidden",!admin());$("exportInventoryPdf").classList.toggle("hidden",!admin());$("manageCategoriesBtn").classList.toggle("hidden",!admin());$("workersNav").classList.toggle("hidden",!admin());$("workerLogoutBtn")?.classList.toggle("hidden",admin());$("adminTabs").classList.toggle("hidden",!admin());$("workerTabs").classList.toggle("hidden",admin());if(!admin()){document.querySelector('[data-tab="daily"]').classList.toggle("hidden",!workerPermission("can_view_own_closeout"));$("shopSellBtn").disabled=!workerPermission("can_sell");}
 document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
 if(admin()){document.querySelector('[data-tab="dashboard"]').classList.add("active");showSection("dashboard");}else{document.querySelector('[data-tab="shop"]').classList.add("active");showSection("shop");}
 // La autenticación ya está confirmada. Los errores de módulos no deben expulsar al usuario.
 const tasks=admin()
  ?[loadProducts,loadSales,loadWorkers,loadAdminDashboard,loadAdminCloseouts,loadAdminIPV]
  :[loadProducts,loadWorkerAllocations,...(workerPermission("can_view_own_closeout")?[loadDailySales]:[]),cacheWorkerState,updatePendingBadge];
 const results=await Promise.allSettled(tasks.map(fn=>Promise.resolve().then(fn)));
 const failed=results.filter(x=>x.status==="rejected");
 if(failed.length){console.error("[IPV module loading]",failed.map(x=>x.reason));toast("Sesión activa. Algunos datos no pudieron actualizarse; puedes reintentar desde la sección correspondiente.");}
 if(admin()&&!window.ipvAdminIPVChannel){window.ipvAdminIPVChannel=client.channel("admin-ipv-live").on("postgres_changes",{event:"*",schema:"public",table:"worker_turn_inventory_items"},()=>{if(!$("inventoryTab").classList.contains("hidden"))loadAdminIPV();}).on("postgres_changes",{event:"*",schema:"public",table:"worker_turn_closures"},()=>{if(!$("inventoryTab").classList.contains("hidden"))loadAdminIPV();}).subscribe((status,error)=>{if(status==="SUBSCRIBED"){console.info("[IPV realtime] Sincronización automática activa.");if(!$("inventoryTab").classList.contains("hidden"))loadAdminIPV();}else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"){console.warn("[IPV realtime] Canal no disponible; se mantiene la actualización manual.",error);}});}
}
$("loginForm").addEventListener("submit",async e=>{
 e.preventDefault();fail("loginError","");
 // Bloquea los cambios de pantalla por eventos de autenticación durante todo el intento.
 loginInProgress=true;
 // Captura los datos antes de cualquier espera para no perder el autocompletado del teléfono.
 const email=$("email").value.trim(),password=$("password").value;
 const btn=$("loginForm").querySelector('button[type="submit"]');
 if(!client&&initPromise){btn.disabled=true;btn.textContent="Iniciando aplicación…";await initPromise;}
 if(!client){if(btn){btn.disabled=false;btn.textContent="Entrar";}return}
 const original=btn?.textContent||"Entrar";if(btn){btn.disabled=true;btn.textContent="Verificando…";}
 try{
  const {data,error}=await client.auth.signInWithPassword({email,password});
  if(error)throw error;
  if(!data?.user)throw new Error("La autenticación no devolvió un usuario.");
  await enter(data.user);
  if(navigator.onLine&&!admin())await syncPendingSales();
 }catch(error){const message=error?.message||"No se pudo completar el inicio de sesión.";showLogin();$("email").value=email;$("password").value=password;fail("loginError","No se pudo completar el acceso: "+message);console.error("[IPV login]",error);}
 finally{loginInProgress=false;if(btn){btn.disabled=false;btn.textContent=original;}}
});
const logout=async()=>{try{await client.auth.signOut();showLogin();}catch(error){toast("No se pudo cerrar la sesión: "+(error?.message||"Error inesperado"));}};$("logoutBtn").addEventListener("click",logout);$("workerLogoutBtn")?.addEventListener("click",logout);
function showSection(tab){["dashboard","inventory","sales","closeouts","activity","workers","shop","daily"].forEach(t=>$(t+"Tab").classList.toggle("hidden",t!==tab));}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{if(b.closest("#adminTabs")){document.body.classList.remove("admin-sidebar-open");$("adminSidebarOverlay")?.classList.add("hidden");$("adminMenuToggle")?.setAttribute("aria-expanded","false");}if((admin()&&["shop","daily"].includes(b.dataset.tab))||(!admin()&&["inventory","sales","workers"].includes(b.dataset.tab)))return;document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));showSection(b.dataset.tab);if(b.dataset.tab==="daily"){loadDailySales();}if(b.dataset.tab==="shop")loadProducts();if(b.dataset.tab==="dashboard")loadAdminDashboard();if(b.dataset.tab==="inventory")loadAdminIPV();if(b.dataset.tab==="closeouts")loadAdminCloseouts();if(b.dataset.tab==="activity")loadActivity();}));
function setAdminSidebar(open){document.body.classList.toggle("admin-sidebar-open",!!open);$("adminSidebarOverlay")?.classList.toggle("hidden",!open);$("adminMenuToggle")?.setAttribute("aria-expanded",open?"true":"false");}
$("adminMenuToggle").addEventListener("click",()=>setAdminSidebar(!document.body.classList.contains("admin-sidebar-open")));
$("adminSidebarClose").addEventListener("click",()=>setAdminSidebar(false));
$("adminSidebarOverlay").addEventListener("click",()=>setAdminSidebar(false));
async function ensureTurnContext(){
 const day=localBusinessDate();
 const {data,error}=await client.rpc("get_last_worker_turn_v2",{p_business_date:day});
 if(error)throw error;
 if(!data?.is_my_turn)throw new Error("Este no es el turno activo. Actualiza IPV o espera el cierre del otro trabajador.");
 const context={businessDate:day,sessionNo:Number(data.session_no)||1,shift:Number((user?.email||"").toLowerCase()==="dependiente1@eltoque.com"?1:2)};
 window.IPV_TURN_CONTEXT=context;
 return context;
}
async function loadProducts(){
 if(user&&!admin()){
  if(!navigator.onLine){const snap=await localGet("worker_snapshot_"+user.id);if(snap){products=snap.products||[];categories=[];workerAllocations=(snap.workerAllocations||[]);renderCategoryControls();renderProducts();}return;}
  const turnCtx=await ensureTurnContext();
  let result=await client.rpc("worker_turn_shop_products",{p_business_date:turnCtx.businessDate,p_session_no:turnCtx.sessionNo});
  // Si la primera petición llega sin un JWT vigente, renovar sesión y repetir una sola vez.
  if(result.error&&(result.error.code==="42501"||result.error.status===401||/permission denied|unauthorized|JWT/i.test(result.error.message||""))){
   const refreshed=await client.auth.refreshSession();
   if(!refreshed.error&&refreshed.data?.session)result=await client.rpc("worker_turn_shop_products",{p_business_date:turnCtx.businessDate,p_session_no:turnCtx.sessionNo});
  }
  const {data,error}=result;
  if(error){console.error("[IPV shop RPC]",{message:error.message,code:error.code,status:error.status});toast("No se pudo cargar la tienda del turno: "+error.message);products=[];workerAllocations=[];renderShopProducts();renderShopCart();return;}
  products=(data||[]).map(x=>({id:x.id,name:x.product_name,price:Number(x.price)||0,stock:Number(x.final_qty)||0,active:true,description:"Disponible para entrega"}));
  categories=[];workerAllocations=products.map(p=>({product_id:p.id,quantity_assigned:p.stock,quantity_remaining:p.stock}));
  renderCategoryControls();renderProducts();renderShopProducts();renderShopCart();await cacheWorkerState();return;
 }
 if(!navigator.onLine)return;
 const [{data,error},{data:categoryData,error:categoryError}]=await Promise.all([client.from("products").select("id,sku,name,description,price,stock,min_stock,active,category_id,image_url").eq("active",true).order("name"),client.from("product_categories").select("id,name,active").eq("active",true).order("name")]);
 if(categoryError){toast("No se pudieron cargar las categorías: "+categoryError.message);return}
 categories=categoryData||[];renderCategoryControls();
 if(error){toast("No se pudo cargar el inventario: "+error.message);return}
 products=data||[];if(admin()){const {data:costs,error:costError}=await client.from("product_costs").select("product_id,average_cost");if(costError){toast("No se pudieron cargar los costos de productos: "+costError.message);return}const costMap=new Map((costs||[]).map(x=>[x.product_id,Number(x.average_cost)||0]));products=products.map(p=>({...p,average_cost:costMap.get(p.id)||0}));}renderProducts();
}
window.addEventListener("ipv:turn-inventory-saved",()=>{if(user&&!admin())loadProducts();});
function renderCategoryControls(){const select=$("productCategory");if(select){const chosen=select.value;select.innerHTML='<option value="">Sin categoría</option>'+categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");select.value=chosen;}const filters=$("shopCategoryFilters");if(filters){filters.innerHTML=[`<button type="button" class="category-chip ${shopCategory==="all"?"active":""}" data-category="all">Todas</button>`,...categories.map(c=>`<button type="button" class="category-chip ${shopCategory===c.id?"active":""}" data-category="${c.id}">${esc(c.name)}</button>`)].join("");}}
$("shopCategoryFilters").addEventListener("click",e=>{const b=e.target.closest("[data-category]");if(!b)return;shopCategory=b.dataset.category;renderCategoryControls();renderShopProducts()});
function renderProducts(){
 const q=$("search").value.trim().toLowerCase(),list=products.filter(p=>(p.name+" "+(p.sku||"")).toLowerCase().includes(q));
 $("productCount").textContent=products.length;$("unitCount").textContent=products.reduce((a,p)=>a+p.stock,0);$("stockValue").textContent=money(products.reduce((a,p)=>a+Number(p.price)*p.stock,0));
 $("productsBody").innerHTML=list.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.sku||"—")}</td><td>${money(p.price)}</td><td>${p.stock}</td><td>${Number(p.min_stock||0)>0?Number(p.min_stock):"—"}${Number(p.min_stock||0)>0&&Number(p.stock)<=Number(p.min_stock)?' <strong class="low-stock-label">Reponer</strong>':""}</td><td>${admin()?`<button class="mini-btn" data-edit="${p.id}">Editar</button> <button class="mini-btn danger" data-delete="${p.id}">Desactivar</button>`:"—"}</td></tr>`).join("");
 $("inventoryEmpty").classList.toggle("hidden",list.length>0);
 const opts=products.map(p=>`<option value="${p.id}">${esc(p.name)} · ${p.stock} disp.</option>`).join("");
 if(!admin()){renderShopProducts();renderShopCart();}
}

async function buildInventoryExport(){
 if(!admin()){toast("Esta exportación está disponible solo para el administrador.");return null;}
 if(!navigator.onLine){toast("Necesitas conexión para consultar el inventario completo.");return null;}
 const [pr,cr,wr,ar,co]=await Promise.all([
  client.from("products").select("id,sku,name,description,price,stock,min_stock,active,category_id").order("name"),
  client.from("product_categories").select("id,name"),
  client.from("profiles").select("id,full_name,role,active").eq("role","worker").order("full_name"),
  client.from("worker_stock_allocations").select("worker_id,product_id,quantity_assigned,quantity_remaining"),
  client.from("product_costs").select("product_id,average_cost")
 ]);
 for(const x of [pr,cr,wr,ar,co])if(x.error){toast("No se pudo preparar el inventario: "+x.error.message);return null;}
 const costMap=new Map((co.data||[]).map(x=>[x.product_id,Number(x.average_cost)||0]));const ps=(pr.data||[]).map(p=>({...p,average_cost:costMap.get(p.id)||0})),cats=cr.data||[],workers=wr.data||[],allocs=ar.data||[];
 const catMap=new Map(cats.map(x=>[x.id,x.name])),workerMap=new Map(workers.map(x=>[x.id,x.full_name||"Trabajador"])),soldMap=new Map(),map=new Map();
 for(const p of ps)map.set(p.id,{p,allocs:[]});
 for(const a of allocs)map.get(a.product_id)?.allocs.push(a);
 for(let from=0;;from+=1000){
  const {data,error}=await client.from("sales").select("id,sale_items(product_id,quantity)").eq("status","completed").order("created_at",{ascending:true}).range(from,from+999);
  if(error){toast("No se pudo consultar el historial de ventas: "+error.message);return null;}
  const page=data||[];for(const sale of page)for(const item of sale.sale_items||[])soldMap.set(item.product_id,(soldMap.get(item.product_id)||0)+Number(item.quantity||0));
  if(page.length<1000)break;
 }
 const inventory=[],detail=[];
 for(const {p,allocs:rows} of map.values()){
  const totalStock=Math.max(0,Number(p.stock)||0),assigned=rows.reduce((n,a)=>n+(Number(a.quantity_assigned)||0),0),remaining=rows.reduce((n,a)=>n+Math.max(0,Number(a.quantity_remaining)||0),0),warehouse=Math.max(0,totalStock-remaining),consumed=rows.reduce((n,a)=>n+Math.max(0,(Number(a.quantity_assigned)||0)-(Number(a.quantity_remaining)||0)),0),sold=Number(soldMap.get(p.id)||0),price=Number(p.price)||0;
  inventory.push({SKU:p.sku||"",Producto:p.name||"",Categoría:catMap.get(p.category_id)||"Sin categoría",Descripción:p.description||"","Precio unitario CUP":price,"Costo promedio CUP":Number(p.average_cost)||0,"Margen unitario estimado CUP":price-(Number(p.average_cost)||0),"Valor de costo disponible CUP":totalStock*(Number(p.average_cost)||0),"Stock mínimo":Number(p.min_stock)||0,"Alerta de reposición":Number(p.min_stock)>0&&totalStock<=Number(p.min_stock)?"Reponer":"Normal","Stock en almacén":warehouse,"Asignado históricamente":assigned,"Disponible en trabajadores":remaining,"Consumo de asignaciones":consumed,"Vendido histórico (ventas completadas)":sold,"Disponible total actual":totalStock,"Valor en almacén CUP":warehouse*price,"Valor disponible trabajadores CUP":remaining*price,"Valor total disponible CUP":totalStock*price,Estado:p.active?"Activo":"Desactivado"});
  for(const a of rows){const aq=Number(a.quantity_assigned)||0,rem=Number(a.quantity_remaining)||0,w=workers.find(x=>x.id===a.worker_id);detail.push({_workerId:a.worker_id,Trabajador:workerMap.get(a.worker_id)||"Trabajador",Estado:w?.active?"Activo":"Desactivado",SKU:p.sku||"",Producto:p.name||"",Categoría:catMap.get(p.category_id)||"Sin categoría","Cantidad asignada":aq,"Cantidad restante":rem,"Consumo de asignación":Math.max(0,aq-rem),"Valor restante CUP":rem*price});}
 }
 const sum=(key)=>inventory.reduce((n,r)=>n+Number(r[key]||0),0);
 const summary=[{Concepto:"Fecha de exportación",Valor:new Date().toLocaleString("es-ES")},{Concepto:"Cuenta administradora",Valor:profile?.full_name||user?.email||"Administrador"},{Concepto:"Correo de la cuenta",Valor:user?.email||"—"},{Concepto:"Productos registrados",Valor:inventory.length},{Concepto:"Productos activos",Valor:inventory.filter(r=>r.Estado==="Activo").length},{Concepto:"Unidades en almacén",Valor:sum("Stock en almacén")},{Concepto:"Unidades disponibles en trabajadores",Valor:sum("Disponible en trabajadores")},{Concepto:"Unidades disponibles totales",Valor:sum("Disponible total actual")},{Concepto:"Valor disponible en almacén (CUP)",Valor:sum("Valor en almacén CUP")},{Concepto:"Valor disponible en trabajadores (CUP)",Valor:sum("Valor disponible trabajadores CUP")},{Concepto:"Valor total disponible (CUP)",Valor:sum("Valor total disponible CUP")}];
 return {inventory,detail,workers,summary,stamp:new Date().toISOString().slice(0,10)};
}
$("exportInventory").addEventListener("click",async()=>{
 const btn=$("exportInventory");btn.disabled=true;btn.textContent="Preparando Excel…";
 try{const d=await buildInventoryExport();if(!d)return;if(!window.XLSX){toast("No se pudo cargar el módulo Excel. Comprueba tu conexión.");return;}
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(d.summary),"Resumen");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(d.inventory),"Inventario general");const usedNames=new Set(["Resumen","Inventario general"]);for(const w of d.workers){const rows=d.detail.filter(r=>r._workerId===w.id).map(({_workerId,...row})=>row);if(!rows.length)rows.push({Trabajador:w.full_name||"Trabajador",Estado:w.active?"Activo":"Desactivado",SKU:"",Producto:"Sin existencias asignadas",Categoría:"","Cantidad asignada":0,"Cantidad restante":0,"Consumo de asignación":0,"Valor restante CUP":0});let base=("Trab - "+(w.full_name||"Trabajador")).replace(/[\\/?*\[\]:]/g," ").trim().slice(0,31)||"Trabajador";let sheetName=base,n=2;while(usedNames.has(sheetName)){const suffix=" "+n++;sheetName=base.slice(0,31-suffix.length)+suffix;}usedNames.add(sheetName);XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),sheetName);}XLSX.writeFile(wb,"Inventario_IPV_"+d.stamp+".xlsx");toast("Inventario Excel preparado: cada trabajador tiene su propia hoja.");
 }catch(e){toast("No se pudo exportar: "+(e?.message||"Error inesperado"));}finally{btn.disabled=false;btn.textContent="Exportar inventario (.xlsx)";}
});
$("exportInventoryPdf").addEventListener("click",async()=>{
 const btn=$("exportInventoryPdf");btn.disabled=true;btn.textContent="Preparando PDF…";
 try{const d=await buildInventoryExport();if(!d)return;if(!window.jspdf?.jsPDF){toast("No se pudo cargar el módulo PDF. Comprueba tu conexión.");return;}
  const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"}),sum=d.summary;
  doc.setFontSize(18);doc.text("IPV Digital - Inventario principal",14,15);doc.setFontSize(9);doc.text("Cuenta: "+(profile?.full_name||user?.email||"Administrador")+" | Correo: "+(user?.email||"—")+" | Fecha: "+new Date().toLocaleString("es-ES"),14,22);
  doc.text("Productos: "+sum[3].Valor+" | Almacén: "+sum[5].Valor+" uds. | Trabajadores: "+sum[6].Valor+" uds. | Disponibles: "+sum[7].Valor+" uds. | Valor: "+money(sum[10].Valor),14,29);
  if(typeof doc.autoTable!=="function"){toast("No se pudo preparar la tabla PDF. Comprueba tu conexión.");return;}
  doc.autoTable({startY:35,head:[["SKU","Producto","Categoría","Precio CUP","Almacén","Trabajadores","Total disp.","Vendido hist.","Estado","Valor disp. CUP"]],body:d.inventory.map(r=>[r.SKU,r.Producto,r.Categoría,Number(r["Precio unitario CUP"]).toFixed(2),String(r["Stock en almacén"]),String(r["Disponible en trabajadores"]),String(r["Disponible total actual"]),String(r["Vendido histórico (ventas completadas)"]),r.Estado,Number(r["Valor total disponible CUP"]).toFixed(2)]),styles:{fontSize:6.5,cellPadding:1.6,overflow:"linebreak"},headStyles:{fillColor:[35,30,20]},columnStyles:{1:{cellWidth:34},2:{cellWidth:22},7:{cellWidth:20}}});
  for(const w of d.workers){doc.addPage();doc.setFontSize(15);doc.text("Existencias asignadas: "+(w.full_name||"Trabajador"),14,16);doc.setFontSize(9);doc.text("Estado: "+(w.active?"Activo":"Desactivado"),14,22);const rows=d.detail.filter(r=>r._workerId===w.id);const body=rows.length?rows.map(r=>[r.SKU,r.Producto,r.Categoría,String(r["Cantidad asignada"]),String(r["Cantidad restante"]),String(r["Consumo de asignación"]),Number(r["Valor restante CUP"]).toFixed(2)]):[["","","Sin existencias asignadas","0","0","0","0,00"]];doc.autoTable({startY:29,head:[["SKU","Producto","Categoría","Asignado","Restante","Consumo","Valor restante CUP"]],body,styles:{fontSize:7,cellPadding:2,overflow:"linebreak"},headStyles:{fillColor:[35,30,20]},columnStyles:{1:{cellWidth:48},2:{cellWidth:28}}});}
  doc.save("Inventario_IPV_"+d.stamp+".pdf");toast("PDF del inventario preparado para guardar en tu teléfono.");
 }catch(e){toast("No se pudo exportar: "+(e?.message||"Error inesperado"));}finally{btn.disabled=false;btn.textContent="Exportar inventario a PDF";}
});

$("search").addEventListener("input",renderProducts);
$("addBtn").addEventListener("click",()=>openProduct());
$("productsBody").addEventListener("click",async e=>{
 const edit=e.target.closest("[data-edit]"),del=e.target.closest("[data-delete]");
 if(edit){const p=products.find(x=>x.id===edit.dataset.edit);openProduct(p)}
 if(del){const p=products.find(x=>x.id===del.dataset.delete);if(p&&confirm(`¿Desactivar ${p.name}?`)){const {error}=await client.from("products").update({active:false}).eq("id",p.id);if(error)toast(error.message);else{toast("Producto desactivado");await loadProducts()}}}
});
function setProductImagePreview(url){const img=$("productImagePreview"),fallback=$("productImageFallback");if(url){img.src=url;img.classList.remove("hidden");fallback.classList.add("hidden");}else{img.removeAttribute("src");img.classList.add("hidden");fallback.classList.remove("hidden");}}
function openProduct(p=null){$("productForm").reset();renderCategoryControls();$("productCategory").value=p?.category_id||"";$("productId").value=p?.id||"";$("dialogTitle").textContent=p?"Editar producto":"Añadir producto";$("name").value=p?.name||"";$("sku").value=p?.sku||"";$("price").value=p?.price??"";$("stock").value=p?.stock??0;$("minStock").value=p?.min_stock??0;$("averageCost").value=p?.average_cost??0;$("description").value=p?.description||"";$("productImageClear").value="0";$("productImageFile").value="";setProductImagePreview(p?.image_url||"");fail("productError","");$("productDialog").showModal()}
$("productImageFile").addEventListener("change",()=>{const file=$("productImageFile").files?.[0];if(file){if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>5*1024*1024){fail("productError","Usa JPG, PNG o WEBP de máximo 5 MB.");$("productImageFile").value="";return;}$("productImageClear").value="0";setProductImagePreview(URL.createObjectURL(file));fail("productError","");}});
$("clearProductImage").addEventListener("click",()=>{$("productImageFile").value="";$("productImageClear").value="1";setProductImagePreview("");});
$("closeDialog").onclick=$("cancelProduct").onclick=()=>$("productDialog").close();
$("productForm").addEventListener("submit",async e=>{
 e.preventDefault();const id=$("productId").value,desiredStock=Number($("stock").value),saveBtn=$("productForm").querySelector('button[type="submit"]');
 if(!Number.isInteger(desiredStock)||desiredStock<0){fail("productError","Las existencias deben ser un número entero igual o mayor que cero.");return}
 const existing=id?products.find(p=>p.id===id):null;
 const minStock=Number($("minStock").value);if(!Number.isInteger(minStock)||minStock<0){fail("productError","El stock mínimo debe ser un entero igual o mayor que cero.");return}const row={name:$("name").value.trim(),sku:$("sku").value.trim()||null,price:Number($("price").value),min_stock:minStock,description:$("description").value.trim()||null,category_id:$("productCategory").value||null};
 saveBtn.disabled=true;fail("productError","");
 const imageFile=$("productImageFile").files?.[0]||null;let imageUrl=existing?.image_url||null;
 if($("productImageClear").value==="1")imageUrl=null;
 if(imageFile){const ext=imageFile.type==="image/png"?"png":imageFile.type==="image/webp"?"webp":"jpg",path=`${crypto.randomUUID()}.${ext}`;const {error:uploadError}=await client.storage.from("product-images").upload(path,imageFile,{contentType:imageFile.type,upsert:false});if(uploadError){saveBtn.disabled=false;fail("productError","No se pudo subir la imagen: "+uploadError.message);return;}imageUrl=client.storage.from("product-images").getPublicUrl(path).data.publicUrl;}
 row.image_url=imageUrl;
 let productId=id;
 if(id){const {error}=await client.from("products").update(row).eq("id",id);if(error){saveBtn.disabled=false;fail("productError",error.message);return}}
 else {const {data,error}=await client.from("products").insert({...row,stock:0}).select("id").single();if(error){saveBtn.disabled=false;fail("productError",error.message);return}productId=data.id}
 const currentStock=existing?.stock??0;
 if(desiredStock!==currentStock){const {error}=await client.rpc("admin_adjust_stock",{p_product_id:productId,p_new_stock:desiredStock,p_notes:id?"Ajuste manual desde catálogo":"Existencia inicial del producto"});if(error){saveBtn.disabled=false;fail("productError","Los datos del producto se guardaron, pero no se pudo ajustar el inventario: "+error.message+". El stock no fue cambiado.");return}}
 saveBtn.disabled=false;$("productDialog").close();toast("Producto e inventario guardados con registro de movimiento");await loadProducts()
});
let shopBounceProductId=null;
function renderShopProducts(){const bounceId=shopBounceProductId;shopBounceProductId=null;const q=( $("shopSearch")?.value||"").trim().toLowerCase();const allowed=admin()?products:products.filter(p=>(workerAllocations.find(a=>a.product_id===p.id)?.quantity_remaining||0)>0);const available=allowed.filter(p=>(admin()?p.stock:(workerAllocations.find(a=>a.product_id===p.id)?.quantity_remaining||0))>0);const list=available.filter(p=>(shopCategory==="all"||p.category_id===shopCategory)&&(p.name+" "+(p.sku||"")+" "+(p.description||"")).toLowerCase().includes(q));$("shopProducts").innerHTML=list.map(p=>{const selected=cart.find(i=>i.product_id===p.id)?.quantity||0;return `<article class="shop-card ${selected?"has-selected":""}"><span class="shop-selected-count ${selected?"is-visible":""} ${selected&&bounceId===p.id?"do-bounce":""}" aria-label="${selected} seleccionados">${selected}</span><div class="shop-card-mark">${p.image_url?`<img class="shop-product-image" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove();this.parentElement.innerHTML='<span>✦</span><small>EL TOQUE</small>'">`:`<span>✦</span><small>EL TOQUE</small>`}</div><div class="shop-card-info"><h3>${esc(p.name)}</h3><p>${esc(p.description||"Disponible para entrega")}</p></div><div class="shop-card-bottom"><strong>${money(p.price)}</strong><span class="shop-stock">${admin()?p.stock:(workerAllocations.find(a=>a.product_id===p.id)?.quantity_remaining||0)} disp.</span></div><button class="primary" data-shop-add="${p.id}">＋ Añadir al pedido</button></article>`}).join("");$("shopEmpty").classList.toggle("hidden",list.length>0);$("shopEmpty").textContent=available.length===0?"No hay productos disponibles en este momento.":"No encontramos productos con esa búsqueda.";}
$("shopSearch").addEventListener("input",renderShopProducts);
$("shopProducts").addEventListener("click",e=>{const b=e.target.closest("[data-shop-add]");if(!b)return;const p=products.find(x=>x.id===b.dataset.shopAdd);const available=admin()?p?.stock:(workerAllocations.find(a=>a.product_id===p?.id)?.quantity_remaining||0);if(!p||available<1)return;const line=cart.find(x=>x.product_id===p.id);if(line){if(line.quantity>=available){fail("shopMessage","No hay más unidades disponibles.");return}line.quantity++;}else cart.push({product_id:p.id,quantity:1});fail("shopMessage","");renderShopCart(true);shopBounceProductId=p.id;renderShopProducts();});
function renderShopCart(animateSelection=false){const count=cart.reduce((n,i)=>n+i.quantity,0),total=cart.reduce((a,i)=>a+(products.find(p=>p.id===i.product_id)?.price||0)*i.quantity,0);$("shopCartCount").textContent=count;$("shopBottomTotal").textContent=money(total);$("shopBottomBar").classList.toggle("hidden",count===0);if(animateSelection&&count>0){const countEl=$("shopCartCount"),totalEl=$("shopBottomTotal");[countEl,totalEl].forEach(el=>{el.classList.remove("do-bounce");void el.offsetWidth;el.classList.add("do-bounce");});}$("shopCartList").innerHTML=cart.map(i=>{const p=products.find(x=>x.id===i.product_id);return `<div class="cart-row"><span>${esc(p?.name||"Producto")} × ${i.quantity}</span><strong>${money((p?.price||0)*i.quantity)}</strong><div class="quantity-actions"><button class="mini-btn" data-shop-minus="${i.product_id}" aria-label="Quitar una unidad">− 1</button><button class="mini-btn danger" data-shop-remove="${i.product_id}">Quitar todo</button></div></div>`}).join("");$("shopCartTotal").textContent=money(total);$("shopOrderEmpty").classList.toggle("hidden",cart.length>0);$("shopSellBtn").disabled=cart.length===0||!workerPermission("can_sell");}
$("shopCartList").addEventListener("click",e=>{const minus=e.target.closest("[data-shop-minus]"),remove=e.target.closest("[data-shop-remove]");if(minus){const line=cart.find(i=>i.product_id===minus.dataset.shopMinus);if(line){line.quantity--;if(line.quantity<=0)cart=cart.filter(i=>i!==line);}renderShopCart();renderShopProducts();return}if(remove){cart=cart.filter(i=>i.product_id!==remove.dataset.shopRemove);renderShopCart();renderShopProducts();}});
function showShopOrder(show){$("shopCatalogView").classList.toggle("hidden",show);$("shopOrderView").classList.toggle("hidden",!show);if(show)renderShopCart();}
$("viewOrderBtn").addEventListener("click",()=>showShopOrder(true));
$("backToCatalog").addEventListener("click",()=>showShopOrder(false));
$("shopPayment").addEventListener("change",()=>{$("transferCodeWrap").classList.toggle("hidden",$("shopPayment").value!=="transfer");if($("shopPayment").value!=="transfer")$("transferCode").value="";});
$("shopSellBtn").addEventListener("click",async()=>{if(!cart.length){fail("shopMessage","Agrega al menos un producto al carrito.");return}const method=$("shopPayment").value,code=$("transferCode").value.trim();if(method==="transfer"&&!code){fail("shopMessage","Introduce el código de la transferencia antes de confirmar.");$("transferCode").focus();return}const btn=$("shopSellBtn");btn.disabled=true;if(!navigator.onLine){try{const entry=await saveOfflineSale(cart,method,code);cart=[];$("transferCode").value="";renderShopCart();showShopOrder(false);fail("shopMessage","Pendiente de sincronizar. Se guardó en este teléfono.");toast("Venta guardada sin conexión");}catch(e){fail("shopMessage","No se pudo guardar localmente. No cierres esta página.");}finally{btn.disabled=false;}return;}fail("shopMessage","Procesando venta…");const id=crypto.randomUUID();let turnCtx;try{turnCtx=await ensureTurnContext();}catch(e){btn.disabled=false;fail("shopMessage",e.message);return;}const {data,error}=await client.rpc("worker_turn_create_sale",{p_items:cart.map(x=>({turn_item_id:x.product_id,quantity:x.quantity})),p_payment_method:method,p_idempotency_key:id,p_transfer_code:method==="transfer"?code:null,p_business_date:turnCtx.businessDate,p_session_no:turnCtx.sessionNo});btn.disabled=false;if(error){if(!navigator.onLine||/fetch|network|failed to fetch|load failed/i.test(error.message||"")){try{await saveOfflineSale(cart,method,code,id);cart=[];renderShopCart();showShopOrder(false);fail("shopMessage","Pendiente de sincronizar. Se guardó en este teléfono.");}catch(e){fail("shopMessage","No se pudo guardar la venta localmente.");}return;}fail("shopMessage",error.message);return;}cart=[];$("transferCode").value="";renderShopCart();showShopOrder(false);fail("shopMessage","Venta confirmada. Folio: "+data);toast("Venta registrada y existencias descontadas");await (window.refreshWorkerTurnInventory?.()||Promise.resolve());await loadProducts();await loadWorkerAllocations();await loadDailySales();});
$("refreshShop").onclick=loadProducts;
function localBusinessDate(d=new Date()){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`;}
let dailyExportRows=[];
let dailyStockRows=[];
let dailyStockCounts=new Map();
let dailyBillCounts={};
const dailyBillDenominations=[5000,2000,1000,500,200,100,50,20,10,5,3,1];
let activeCloseout=null;
async function loadDailySales(){if(!user||admin())return;const dayKey=localBusinessDate();dailyBillCounts=(await localGet("daily_bill_counts_"+user.id+"_"+dayKey))||{};renderDailyBillCounts();return;if(!navigator.onLine){$("dailyCloseStatus").textContent="Sin conexión: el cuadre requiere datos actualizados del servidor. Las ventas guardadas siguen pendientes de sincronizar.";await updatePendingBadge();return;}const now=new Date(),start=new Date(now.getFullYear(),now.getMonth(),now.getDate()),end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);$("dailyDate").textContent=start.toLocaleDateString("es-ES",{weekday:"long",year:"numeric",month:"long",day:"numeric"});const {data,error}=await client.from("sales").select("id,total,payment_method,transfer_code,created_at,status,sale_items(product_id,worker_turn_item_id,product_name,quantity,unit_price,products(name))").eq("status","completed").gte("created_at",start.toISOString()).lt("created_at",end.toISOString()).order("created_at",{ascending:false});if(error){toast("No se pudo cargar el cuadre: "+error.message);return}
 const {data:closed,error:closeErr}=await client.from("daily_closeouts").select("id,business_date,sales_count,cash_total,transfer_total,grand_total,cash_counted,cash_difference,bill_counts,stock_snapshot,closed_at").eq("business_date",dayKey).maybeSingle();
 if(closeErr){toast("No se pudo consultar el cierre: "+closeErr.message);return}
 activeCloseout=closed||null;
 dailyBillCounts=closed&&closed.cash_counted!==null?(closed.bill_counts||{}):((await localGet("daily_bill_counts_"+user.id+"_"+dayKey))||{});renderDailyBillCounts();
 const closeBtn=$("closeDaily");closeBtn.disabled=!!activeCloseout||!navigator.onLine;closeBtn.textContent=activeCloseout?"Jornada cerrada":"Cerrar y bloquear día";
 $("dailyCloseStatus").textContent=activeCloseout?`Cierre confirmado el ${new Date(activeCloseout.closed_at).toLocaleString("es-ES")}. ${activeCloseout.cash_counted===null?"Este cierre anterior no guardó el conteo de efectivo.":"Efectivo contado: "+money(activeCloseout.cash_counted)+" · Diferencia: "+money(activeCloseout.cash_difference)}. Esta jornada está bloqueada.`:(!workerPermission("can_count_stock")?"Jornada abierta: tu cuenta no tiene permiso para contar existencias; completa el conteo de billetes antes de cerrar.":"Jornada abierta: completa el conteo físico y de billetes antes de cerrar. El cierre guardará una copia definitiva.");
 const {data:counts,error:countsErr}=await client.from("worker_daily_stock_counts").select("product_id,expected_quantity,physical_quantity,counted_at").eq("worker_id",user.id).eq("business_date",dayKey);
 if(countsErr){toast("No se pudo cargar el conteo físico: "+countsErr.message);return;}
 dailyStockCounts=new Map((counts||[]).map(c=>[c.product_id,c]));
 const soldByProduct=new Map();
 for(const sale of (data||[]))for(const item of (sale.sale_items||[]))soldByProduct.set(item.product_id,(soldByProduct.get(item.product_id)||0)+Number(item.quantity||0));
 dailyStockRows=workerAllocations.map(a=>{const p=products.find(x=>x.id===a.product_id);if(!p)return null;const expected=Number(a.quantity_remaining)||0;const sold=Number(a.quantity_assigned||0)-expected;const saved=dailyStockCounts.get(a.product_id);const validSaved=saved&&Number(saved.expected_quantity)===expected;return {product_id:a.product_id,name:p.name,assigned:Number(a.quantity_assigned)||expected+sold,sold,expected,physical:validSaved?Number(saved.physical_quantity):null,difference:validSaved?Number(saved.physical_quantity)-expected:null};}).filter(Boolean);
 renderDailyStockCounts();
 const rows=data||[];dailyExportRows=rows;const cash=rows.filter(x=>x.payment_method==="cash").reduce((a,x)=>a+Number(x.total),0),transfer=rows.filter(x=>x.payment_method==="transfer").reduce((a,x)=>a+Number(x.total),0),total=cash+transfer;$("dailyCount").textContent=rows.length;$("dailyCash").textContent=money(cash);$("dailyTransfer").textContent=money(transfer);$("dailyTotal").textContent=money(total);$("dailySalesBody").innerHTML=rows.map(x=>{const items=(x.sale_items||[]).map(i=>`${esc(i.product_name||i.products?.name||"Producto")} × ${Number(i.quantity)||0}`).join("<br>")||"—";return `<tr><td>${new Date(x.created_at).toLocaleTimeString("es-ES")}</td><td>${items}</td><td>${money(x.total)}</td><td>${x.payment_method==="cash"?"CUP":"Transferencia"}</td><td>${esc(x.transfer_code||"—")}</td></tr>`}).join("");$("dailyEmpty").classList.toggle("hidden",rows.length>0);await updatePendingBadge();}
function renderDailyStockCounts(){
 const body=$("dailyStockBody");if(!body)return;
 body.innerHTML=dailyStockRows.map(r=>{const value=r.physical===null?"":r.physical;const diff=r.difference===null?"Pendiente":(r.difference>0?"+":"")+r.difference;return `<tr><td>${esc(r.name)}</td><td>${r.assigned}</td><td>${r.sold}</td><td><strong>${r.expected}</strong></td><td><input class="daily-physical-input" type="number" min="0" step="1" inputmode="numeric" data-stock-count="${r.product_id}" value="${value}" aria-label="Conteo físico de ${esc(r.name)}" ${activeCloseout||!workerPermission("can_count_stock")?"disabled":""}></td><td>${diff}</td></tr>`}).join("")||'<tr><td colspan="6">No tienes productos asignados.</td></tr>';
 const pending=dailyStockRows.filter(r=>r.physical===null).length;
 $("dailyStockStatus").textContent=!workerPermission("can_count_stock")?"Tu cuenta no tiene permiso para registrar el conteo físico.":pending?`${pending} producto(s) pendiente(s) de contar.`:"Conteo físico guardado para todos los productos.";
}
function renderDailyBillCounts(){
 const body=$("dailyBillsBody");if(!body)return;
 body.innerHTML=dailyBillDenominations.map(value=>{const quantity=Math.max(0,Number(dailyBillCounts[value])||0);return `<tr><td><strong>${value.toLocaleString("es-ES")} CUP</strong></td><td><input class="daily-bill-input" type="number" min="0" step="1" inputmode="numeric" data-bill-denomination="${value}" value="${quantity}" aria-label="Cantidad de billetes de ${value} CUP"></td><td>${money(value*quantity)}</td></tr>`}).join("");
 const total=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);
 $("dailyBillsTotal").textContent=money(total);
 $("dailyBillsStatus").textContent="El conteo se conserva en este teléfono para la cuenta y la fecha actuales.";
}
$("dailyBillsBody")?.addEventListener("input",e=>{
 const input=e.target.closest("[data-bill-denomination]");if(!input)return;
 const denomination=Number(input.dataset.billDenomination),quantity=input.value===""?0:Number(input.value);
 if(!Number.isInteger(quantity)||quantity<0)return;
 dailyBillCounts[denomination]=quantity;
 const row=input.closest("tr");if(row)row.cells[2].textContent=money(denomination*quantity);
 const total=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);
 $("dailyBillsTotal").textContent=money(total);
});
$("dailyBillsBody")?.addEventListener("change",async e=>{
 const input=e.target.closest("[data-bill-denomination]");if(!input)return;
 const quantity=input.value===""?0:Number(input.value);
 if(!Number.isInteger(quantity)||quantity<0){toast("Introduce una cantidad entera igual o mayor que cero.");return;}
 dailyBillCounts[Number(input.dataset.billDenomination)]=quantity;
 try{await localPut("daily_bill_counts_"+user.id+"_"+localBusinessDate(),dailyBillCounts);}
 catch(error){toast("No se pudo guardar el conteo de billetes en este teléfono.");}
});
$("dailyStockBody")?.addEventListener("change",async e=>{
 const input=e.target.closest("[data-stock-count]");if(!input)return;const quantity=Number(input.value);if(!Number.isInteger(quantity)||quantity<0){toast("Introduce una cantidad entera igual o mayor que cero.");return;}
 const row=dailyStockRows.find(r=>r.product_id===input.dataset.stockCount);if(!row)return;input.disabled=true;
 const {data,error}=await client.from("worker_daily_stock_counts").upsert({worker_id:user.id,business_date:localBusinessDate(),product_id:row.product_id,expected_quantity:row.expected,physical_quantity:quantity,counted_at:new Date().toISOString()},{onConflict:"worker_id,business_date,product_id"}).select("product_id,expected_quantity,physical_quantity,counted_at").single();
 input.disabled=false;if(error){toast("No se pudo guardar el conteo: "+error.message);return;}
 dailyStockCounts.set(row.product_id,data);row.physical=quantity;row.difference=quantity-row.expected;renderDailyStockCounts();toast("Conteo físico guardado.");
});
const closeDailyButton=$("closeDaily");if(closeDailyButton)closeDailyButton.onclick=async()=>{
 if(!navigator.onLine){toast("Necesitas conexión para cerrar la jornada.");return}
 if(await updatePendingBadge()){toast("Primero sincroniza todas las ventas pendientes.");return}
 if(activeCloseout){toast("Esta jornada ya está cerrada.");return}
 if(!confirm("¿Confirmas el cierre de tu jornada? Se guardará el detalle y no podrás registrar más ventas con la fecha de hoy."))return;
 const now=new Date(),start=new Date(now.getFullYear(),now.getMonth(),now.getDate()),end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
 const btn=$("closeDaily");btn.disabled=true;btn.textContent="Cerrando…";
 const cashCounted=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);const {data,error}=await client.rpc("close_daily_register",{p_business_date:localBusinessDate(start),p_start:start.toISOString(),p_end:end.toISOString(),p_cash_counted:cashCounted,p_bill_counts:dailyBillCounts});
 if(error){btn.disabled=false;btn.textContent="Cerrar y bloquear día";toast("No se pudo cerrar la jornada: "+error.message);return}
 toast("Jornada cerrada y guardada. Folio: "+data);await loadDailySales();await loadCloseoutHistory();
};
async function loadCloseoutHistory(){
 const {data,error}=await client.from("daily_closeouts").select("id,business_date,sales_count,cash_total,transfer_total,grand_total,cash_counted,cash_difference,closed_at").order("business_date",{ascending:false}).limit(30);
 if(error){toast("No se pudo cargar el historial de cierres: "+error.message);return}
 $("closeoutHistoryBody").innerHTML=(data||[]).map(c=>`<tr><td>${esc(c.business_date)}</td><td>${new Date(c.closed_at).toLocaleString("es-ES")}</td><td>${c.sales_count}</td><td>${money(c.cash_total)}</td><td>${money(c.transfer_total)}</td><td>${money(c.grand_total)}</td><td>${c.cash_counted===null?"—":money(c.cash_counted)}</td><td>${c.cash_difference===null?"—":money(c.cash_difference)}</td><td>${esc(c.id)}</td></tr>`).join("");
 $("closeoutHistoryEmpty").classList.toggle("hidden",!!(data||[]).length);
}
$("refreshDaily")?.addEventListener("click",async()=>{await loadDailySales();});
const exportDailyButton=$("exportDaily");if(exportDailyButton)exportDailyButton.onclick=()=>{
 if(!dailyExportRows.length){toast("No hay ventas de hoy para exportar.");return}
 if(!window.XLSX){toast("No se pudo cargar el módulo de Excel. Comprueba tu conexión e inténtalo de nuevo.");return}
 const detail=[];
 for(const sale of dailyExportRows){
  const items=sale.sale_items||[];
  if(items.length){for(const item of items){detail.push({Fecha:new Date(sale.created_at).toLocaleDateString("es-ES"),Hora:new Date(sale.created_at).toLocaleTimeString("es-ES"),Producto:item.product_name||item.products?.name||"Producto",Cantidad:Number(item.quantity)||0,"Precio unitario":Number(item.unit_price)||0,"Importe línea":(Number(item.unit_price)||0)*(Number(item.quantity)||0),"Total de venta":Number(sale.total)||0,"Forma de pago":sale.payment_method==="cash"?"CUP":"Transferencia","Código de transferencia":sale.transfer_code||"—",Folio:sale.id})}}
  else detail.push({Fecha:new Date(sale.created_at).toLocaleDateString("es-ES"),Hora:new Date(sale.created_at).toLocaleTimeString("es-ES"),Producto:"—",Cantidad:0,"Precio unitario":0,"Importe línea":0,"Total de venta":Number(sale.total)||0,"Forma de pago":sale.payment_method==="cash"?"CUP":"Transferencia","Código de transferencia":sale.transfer_code||"—",Folio:sale.id});
 }
 const cash=dailyExportRows.filter(x=>x.payment_method==="cash").reduce((a,x)=>a+Number(x.total),0);
 const transfer=dailyExportRows.filter(x=>x.payment_method==="transfer").reduce((a,x)=>a+Number(x.total),0);
 const accountName=profile?.full_name||user?.email||"Cuenta sin nombre";
 const accountEmail=user?.email||"—";
 const accountRole=profile?.role||"trabajador";
 const cashCounted=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);const summary=[{"Concepto":"Cuenta","Valor":accountName},{"Concepto":"Correo de la cuenta","Valor":accountEmail},{"Concepto":"Tipo de cuenta","Valor":accountRole},{"Concepto":"Fecha de exportación","Valor":new Date().toLocaleString("es-ES")},{"Concepto":"Cantidad de ventas","Valor":dailyExportRows.length},{"Concepto":"Total CUP","Valor":cash},{"Concepto":"Total Transferencias","Valor":transfer},{"Concepto":"Total vendido","Valor":cash+transfer},{"Concepto":"Efectivo contado","Valor":cashCounted},{"Concepto":"Diferencia de caja","Valor":cashCounted-cash}];
 const stockDetail=dailyStockRows.map(r=>({Producto:r.name,Asignado:r.assigned,Vendido:r.sold,"Debe quedar":r.expected,"Conteo físico":r.physical===null?"Pendiente":r.physical,Diferencia:r.difference===null?"Pendiente":r.difference}));
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(detail),"Detalle de ventas");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summary),"Resumen");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(stockDetail),"Conteo físico");
 const billDetail=dailyBillDenominations.filter(value=>(Number(dailyBillCounts[value])||0)>0).map(value=>({"Denominación":value+" CUP","Cantidad de billetes":Number(dailyBillCounts[value])||0,"Importe CUP":value*(Number(dailyBillCounts[value])||0)}));const billTotal=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);billDetail.push({"Denominación":"TOTAL EFECTIVO CONTADO","Cantidad de billetes":dailyBillDenominations.reduce((sum,value)=>sum+(Number(dailyBillCounts[value])||0),0),"Importe CUP":billTotal});XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(billDetail),"Conteo de billetes");
 const stamp=new Date().toISOString().slice(0,10);XLSX.writeFile(wb,`Cuadre_IPV_${stamp}.xlsx`);toast("Archivo Excel preparado para guardar en tu teléfono.");
};


const exportDailyPdfButton=$("exportDailyPdf");if(exportDailyPdfButton)exportDailyPdfButton.onclick=()=>{
 if(!dailyExportRows.length){toast("No hay ventas de hoy para exportar.");return}
 if(!window.jspdf?.jsPDF){toast("No se pudo cargar el módulo PDF. Comprueba tu conexión e inténtalo de nuevo.");return}
 const {jsPDF}=window.jspdf;const doc=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
 const cash=dailyExportRows.filter(x=>x.payment_method==="cash").reduce((a,x)=>a+Number(x.total),0);
 const transfer=dailyExportRows.filter(x=>x.payment_method==="transfer").reduce((a,x)=>a+Number(x.total),0);
 const stamp=new Date().toLocaleDateString("es-ES");
 const accountName=profile?.full_name||user?.email||"Cuenta sin nombre";
 const accountEmail=user?.email||"—";
 const accountRole=profile?.role||"trabajador";
 doc.setFontSize(18);doc.text("IPV Digital - Cuadre del día",14,16);
 doc.setFontSize(10);doc.text("Cuenta: "+accountName+"    Correo: "+accountEmail+"    Tipo: "+accountRole,14,23);
 doc.text("Fecha: "+stamp,14,30);
 const cashCounted=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);doc.text("Ventas: "+dailyExportRows.length+"    Total CUP: "+cash.toFixed(2)+" CUP    Total Transferencias: "+transfer.toFixed(2)+" CUP    Total vendido: "+(cash+transfer).toFixed(2)+" CUP",14,37);doc.text("Efectivo contado: "+cashCounted.toFixed(2)+" CUP    Diferencia de caja: "+(cashCounted-cash).toFixed(2)+" CUP",14,43);
 const body=[];
 for(const sale of dailyExportRows){
  const when=new Date(sale.created_at);
  const products=(sale.sale_items||[]).map(i=>(i.product_name||i.products?.name||"Producto")+" × "+(Number(i.quantity)||0)).join(", ")||"—";
  body.push([when.toLocaleTimeString("es-ES"),products,Number(sale.total||0).toFixed(2)+" CUP",sale.payment_method==="cash"?"CUP":"Transferencia",sale.transfer_code||"—",String(sale.id||"")]);
 }
 if(typeof doc.autoTable!=="function"){toast("No se pudo preparar la tabla PDF. Comprueba tu conexión.");return}
 doc.autoTable({startY:49,head:[["Hora","Productos y cantidades","Importe","Pago","Código transferencia","Folio"]],body,styles:{fontSize:8,cellPadding:2,overflow:"linebreak"},headStyles:{fillColor:[7,85,164]},columnStyles:{1:{cellWidth:75},5:{cellWidth:45}}});
 let nextY=(doc.lastAutoTable?.finalY||43)+10;doc.setFontSize(13);doc.text("Conteo físico de existencias",14,nextY);if(typeof doc.autoTable==="function"){doc.autoTable({startY:nextY+4,head:[["Producto","Asignado","Vendido","Debe quedar","Conteo físico","Diferencia"]],body:dailyStockRows.map(r=>[r.name,String(r.assigned),String(r.sold),String(r.expected),r.physical===null?"Pendiente":String(r.physical),r.difference===null?"Pendiente":String(r.difference)]),styles:{fontSize:8,cellPadding:2},headStyles:{fillColor:[7,85,164]}});}let billsY=(doc.lastAutoTable?.finalY||nextY+4)+10;if(billsY>175){doc.addPage();billsY=18;}doc.setFontSize(13);doc.text("Conteo de billetes",14,billsY);const billTotal=dailyBillDenominations.reduce((sum,value)=>sum+value*(Number(dailyBillCounts[value])||0),0);doc.autoTable({startY:billsY+4,head:[["Denominación","Cantidad de billetes","Importe"]],body:dailyBillDenominations.filter(value=>(Number(dailyBillCounts[value])||0)>0).map(value=>[value.toLocaleString("es-ES")+" CUP",String(Number(dailyBillCounts[value])||0),money(value*(Number(dailyBillCounts[value])||0))]),foot:[["TOTAL EFECTIVO CONTADO",String(dailyBillDenominations.reduce((sum,value)=>sum+(Number(dailyBillCounts[value])||0),0)),money(billTotal)]],styles:{fontSize:9,cellPadding:2},headStyles:{fillColor:[7,85,164]},footStyles:{fillColor:[238,231,214],textColor:[25,22,16],fontStyle:"bold"}});doc.save("Cuadre_IPV_"+new Date().toISOString().slice(0,10)+".pdf");toast("PDF preparado para guardar en tu teléfono.");
};

async function loadActivity(){
 if(!admin())return;
 const {data,error}=await client.from("activity_log").select("id,actor_id,action,entity_type,entity_id,details,created_at,profiles(full_name)").order("created_at",{ascending:false}).limit(100);
 if(error){toast("No se pudo cargar la actividad: "+error.message);return}
 const labels={product_created:"Producto creado",product_updated:"Producto actualizado",sale_created:"Venta registrada",sale_cancelled:"Venta cancelada",stock_movement:"Movimiento de inventario",stock_assigned:"Existencias asignadas",stock_allocation_updated:"Asignación modificada",worker_profile_updated:"Trabajador actualizado",worker_created:"Trabajador creado",daily_closeout:"Jornada cerrada",stock_receipt:"Entrada de mercancía"};
 $("activityBody").innerHTML=(data||[]).map(x=>'<tr><td>'+new Date(x.created_at).toLocaleString("es-ES")+'</td><td>'+esc(x.profiles?.full_name||"Sistema")+'</td><td>'+esc(labels[x.action]||x.action)+'</td><td>'+esc(x.entity_type)+' · '+esc(String(x.entity_id||"").slice(0,8))+'</td><td>'+esc(JSON.stringify(x.details||{}))+'</td></tr>').join("");
 $("activityEmpty").classList.toggle("hidden",!!(data||[]).length);
}
$("refreshActivity").addEventListener("click",loadActivity);
async function loadAdminDashboard(){
 if(!admin()||!navigator.onLine)return;
 const now=new Date(),todayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate()),tomorrow=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1),monthStart=new Date(now.getFullYear(),now.getMonth(),1);
 const sales=[];for(let from=0;;from+=1000){const page=await client.from("sales").select("id,total,payment_method,created_at").eq("status","completed").gte("created_at",monthStart.toISOString()).lt("created_at",tomorrow.toISOString()).order("created_at",{ascending:false}).range(from,from+999);if(page.error){toast("No se pudo actualizar el resumen: "+page.error.message);return}sales.push(...(page.data||[]));if(!page.data||page.data.length<1000)break;}
 const [productsResult,workersResult]=await Promise.all([
  client.from("products").select("id,stock").eq("active",true),
  client.from("profiles").select("id").eq("role","worker").eq("active",true)
 ]);
 for(const x of [productsResult,workersResult])if(x.error){toast("No se pudo actualizar el resumen: "+x.error.message);return}
 const today=sales.filter(x=>new Date(x.created_at)>=todayStart);
 const todayTotal=today.reduce((n,x)=>n+Number(x.total||0),0),monthTotal=sales.reduce((n,x)=>n+Number(x.total||0),0);
 const todayCash=today.filter(x=>x.payment_method==="cash").reduce((n,x)=>n+Number(x.total||0),0),todayTransfer=today.filter(x=>x.payment_method==="transfer").reduce((n,x)=>n+Number(x.total||0),0);
 const stockTotal=(productsResult.data||[]).reduce((n,p)=>n+Number(p.stock||0),0);
 $("dashSalesToday").textContent=money(todayTotal);$("dashSalesTodayCount").textContent=today.length+" operaciones";
 $("dashSalesMonth").textContent=money(monthTotal);$("dashSalesMonthCount").textContent=sales.length+" operaciones";
 $("dashCashToday").textContent=money(todayCash);$("dashTransferToday").textContent=money(todayTransfer);
 $("dashStockTotal").textContent=stockTotal.toLocaleString("es-ES");$("dashActiveWorkers").textContent=(workersResult.data||[]).length;
 $("dashboardUpdated").textContent="Actualizado: "+now.toLocaleString("es-ES");
}
async function loadAdminIPV(){
 if(!admin()||!navigator.onLine)return;
 const body=$("adminIPVRows");
 $("adminIPVSession").textContent="Consultando la sesión de trabajo más reciente…";
 body.innerHTML='<tr><td colspan="8" class="muted">Actualizando…</td></tr>';
 try{
  const day=localBusinessDate();
  const [{data:latestClosure,error:closureError},{data:items,error:itemError}]=await Promise.all([
   client.from("worker_turn_closures").select("closure_no,session_no").order("closure_no",{ascending:false}).limit(1).maybeSingle(),
   client.from("worker_turn_inventory_items").select("worker_id,shift_no,business_date,session_no,row_no,product_name,start_qty,entry_qty,available_qty,final_qty,sold_qty,price,amount,updated_at").eq("business_date",day).order("updated_at",{ascending:false}).limit(500)
  ]);
  if(closureError)throw closureError;
  if(itemError)throw itemError;
  const lastClosedSession=Number(latestClosure?.session_no)||0;
  const openRows=(items||[]).filter(x=>Number(x.session_no)>lastClosedSession);
  if(!openRows.length){
   adminIPVTarget=null;
   body.innerHTML='<tr><td colspan="8" class="muted">No hay una sesión de turno abierta con actividad registrada en la fecha actual.</td></tr>';
   $("adminIPVSession").textContent="Sin turno activo detectado";
   $("adminIPVTotal").textContent=money(0);
   $("adminIPVRowCount").textContent="0 productos";
   $("adminIPVLastUpdate").textContent="Sin actividad reciente";
   return;
  }
  const newest=openRows[0];
  adminIPVTarget={worker_id:newest.worker_id,business_date:newest.business_date,session_no:Number(newest.session_no)};
  const activeRows=openRows.filter(x=>x.worker_id===newest.worker_id&&Number(x.shift_no)===Number(newest.shift_no)&&Number(x.session_no)===Number(newest.session_no)&&x.business_date===newest.business_date).sort((a,b)=>Number(a.row_no)-Number(b.row_no));
  const {data:worker,error:workerError}=await client.from("profiles").select("full_name").eq("id",newest.worker_id).maybeSingle();
  if(workerError)throw workerError;
  body.innerHTML=activeRows.map(x=>'<tr><td>'+esc(x.product_name||"—")+'</td><td>'+Number(x.start_qty||0)+'</td><td>'+Number(x.entry_qty||0)+'</td><td>'+Number(x.available_qty||0)+'</td><td>'+Number(x.final_qty||0)+'</td><td>'+Number(x.sold_qty||0)+'</td><td>'+money(x.price)+'</td><td>'+money(x.amount)+'</td></tr>').join("");
  const total=activeRows.reduce((sum,x)=>sum+(Number(x.amount)||0),0);
  $("adminIPVSession").textContent=(worker?.full_name||("Turno "+Number(newest.shift_no)))+" · Turno "+Number(newest.shift_no)+" · Sesión "+Number(newest.session_no)+" · "+new Date(newest.business_date+"T00:00:00").toLocaleDateString("es-ES");
  $("adminIPVTotal").textContent=money(total);
  $("adminIPVRowCount").textContent=activeRows.length+" productos";
  $("adminIPVLastUpdate").textContent="Última actualización: "+new Date(newest.updated_at).toLocaleString("es-ES");
 }catch(error){
  console.error("[IPV admin live table]",error);
  body.innerHTML='<tr><td colspan="8" class="muted">No se pudo actualizar la tabla IPV: '+esc(error.message||"Error inesperado")+'</td></tr>';
  $("adminIPVSession").textContent="Error al consultar el turno";
 }
}
$("refreshAdminIPV")?.addEventListener("click",loadAdminIPV);

$("submitAdminIPVEntry")?.addEventListener("click",async()=>{
 if(!admin()||!adminIPVTarget||!navigator.onLine){toast("No hay una sesión activa disponible para recibir entradas.");return;}
 const name=$("adminIPVProduct")?.value.trim()||"",qty=Number($("adminIPVQuantity")?.value),price=Number($("adminIPVPrice")?.value||0);
 if(!name||!Number.isInteger(qty)||qty<=0||!Number.isFinite(price)||price<0){toast("Introduce un producto y una cantidad válida.");return;}
 const button=$("submitAdminIPVEntry");button.disabled=true;
 try{
  const {error}=await client.rpc("admin_create_worker_entry_request",{p_worker_id:adminIPVTarget.worker_id,p_business_date:adminIPVTarget.business_date,p_session_no:adminIPVTarget.session_no,p_product_name:name,p_quantity:qty,p_price:price});
  if(error)throw error;
  $("adminIPVProduct").value="";$("adminIPVQuantity").value="";$("adminIPVPrice").value="";
  toast("Entrada enviada. No se sumará al IPV hasta que el trabajador la apruebe.");
 }catch(error){toast("No se pudo enviar la entrada: "+(error.message||"Error inesperado"));}
 finally{button.disabled=false;}
});

async function loadAdminCloseouts(){
 if(!admin()||!navigator.onLine)return;
 const {data,error}=await client.from("worker_turn_closures").select("id,closure_no,worker_id,shift_no,business_date,session_no,total,rows,created_at,profiles(full_name)").order("created_at",{ascending:false}).limit(100);
 if(error){toast("No se pudieron cargar los cierres de turnos: "+error.message);return}
 const records=data||[];
 $("adminCloseoutsBody").innerHTML=records.map(c=>{
  const lines=Array.isArray(c.rows)?c.rows:[];
  const sold=lines.reduce((n,x)=>n+Number(x.sold||0),0);
  const doc=c.closure_no??c.id;
  return "<tr><td>"+esc(c.business_date)+"</td><td>Turno "+Number(c.shift_no||0)+"</td><td>"+Number(c.session_no||1)+"</td><td>"+esc(c.profiles?.full_name||"Trabajador")+"</td><td>"+lines.length+"</td><td>"+sold+"</td><td>"+money(c.total)+"</td><td>"+esc(String(doc))+"</td></tr>";
 }).join("");
 $("adminCloseoutsEmpty").classList.toggle("hidden",records.length>0);
}
$("refreshDashboard").addEventListener("click",loadAdminDashboard);
$("refreshAdminCloseouts").addEventListener("click",loadAdminCloseouts);
let allAdminSales=[];
async function loadSales(){
 if(!user)return;
 const rows=[];
 for(let from=0;;from+=1000){
  const {data,error}=await client.from("sales").select("id,worker_id,total,payment_method,transfer_code,status,cancel_reason,created_at,profiles!sales_worker_id_fkey(full_name),sale_items(worker_turn_item_id,product_name,quantity,unit_price,products(name))").order("created_at",{ascending:false}).range(from,from+999);
  if(error){toast("Ventas: "+error.message);return}
  rows.push(...(data||[]));if(!data||data.length<1000)break;
 }
 allAdminSales=rows;
 const workerSelect=$("salesWorker"),selected=workerSelect.value;
 const names=new Map();
 allAdminSales.forEach(s=>{if(s.worker_id)names.set(s.worker_id,s.profiles?.full_name||"Trabajador");});
 workerSelect.innerHTML='<option value="">Todos los trabajadores</option>'+[...names.entries()].map(([id,name])=>'<option value="'+esc(id)+'">'+esc(name)+'</option>').join("");
 workerSelect.value=selected;
 renderAdminSales();
}
function renderAdminSales(){
 const from=$("salesFrom").value,to=$("salesTo").value,worker=$("salesWorker").value;
 const rows=allAdminSales.filter(s=>{
  const day=String(s.created_at||"").slice(0,10);
  return (!from||day>=from)&&(!to||day<=to)&&(!worker||s.worker_id===worker);
 });
 const groups=new Map();
 rows.filter(s=>s.status==="completed").forEach(s=>{const id=s.worker_id||"unknown",g=groups.get(id)||{name:s.profiles?.full_name||"Trabajador",count:0,cash:0,transfer:0,total:0};g.count++;g.total+=Number(s.total)||0;if(s.payment_method==="transfer")g.transfer+=Number(s.total)||0;else g.cash+=Number(s.total)||0;groups.set(id,g);});
 $("salesWorkerSummary").innerHTML=[...groups.values()].map(g=>'<article class="stat"><span>'+esc(g.name)+'</span><strong>'+g.count+' ventas</strong><small>CUP: '+money(g.cash)+' · Transferencias: '+money(g.transfer)+' · Total: '+money(g.total)+'</small></article>').join("")||'<p class="muted small">No hay ventas en este período.</p>';
 $("salesBody").innerHTML=rows.map(s=>{
  const items=(s.sale_items||[]).map(i=>esc(i.product_name||i.products?.name||"Producto")+" × "+(Number(i.quantity)||0)).join("<br>")||"—";
  return '<tr><td>'+new Date(s.created_at).toLocaleString("es-ES")+'</td><td>'+esc(s.profiles?.full_name||"Trabajador")+'</td><td>'+items+'</td><td>'+money(s.total)+'</td><td>'+esc(({cash:"CUP",card:"Tarjeta",transfer:"Transferencia"})[s.payment_method]||s.payment_method||"—")+'</td><td>'+esc(s.transfer_code||"—")+'</td><td>'+esc(s.status||"—")+(s.cancel_reason?'<small>'+esc(s.cancel_reason)+'</small>':"")+'</td><td>'+(s.status==="completed"?'<button class="mini-btn danger" data-cancel-sale="'+s.id+'">Cancelar</button>':"—")+'</td></tr>';
 }).join("");
 $("salesEmpty").classList.toggle("hidden",rows.length>0);
}
$("salesBody").addEventListener("click",async e=>{
 const b=e.target.closest("[data-cancel-sale]");if(!b)return;
 const sale=allAdminSales.find(x=>x.id===b.dataset.cancelSale);if(!sale||sale.status!=="completed")return;
 const reason=prompt("Indica el motivo de la cancelación de esta venta:");if(reason===null)return;
 if(reason.trim().length<4){toast("Escribe un motivo de al menos 4 caracteres.");return}
 if(!confirm("¿Confirmas cancelar la venta? Las unidades volverán a las existencias del trabajador y quedará un registro permanente."))return;
 b.disabled=true;const {data,error}=await client.rpc("admin_cancel_sale",{p_sale_id:sale.id,p_reason:reason.trim()});
 if(error){b.disabled=false;toast("No se pudo cancelar: "+error.message);return}
 toast("Venta cancelada y existencias restituidas.");
 await Promise.all([loadSales(),loadProducts(),loadAdminDashboard(),loadActivity()]);
});
$("refreshSales").onclick=loadSales;
["salesFrom","salesTo","salesWorker"].forEach(id=>$(id).addEventListener("change",renderAdminSales));

let workerRows=[];
async function loadWorkers(){
 const {data:{session}}=await client.auth.getSession();
 const response=await fetch(cfg.url+"/functions/v1/list-workers",{method:"POST",headers:{"Content-Type":"application/json","apikey":cfg.publishableKey,"Authorization":"Bearer "+session.access_token},body:"{}"});
 const result=await response.json();if(!response.ok){toast(result.error||"No se pudo cargar el equipo");return}
 workerRows=result.workers||[];$("workersEmpty")?.classList.toggle("hidden",workerRows.length>0);
 $("workersBody").innerHTML=workerRows.map(w=>`<tr><td>${esc(w.full_name)}</td><td>${esc(w.email||"—")}</td><td>${w.active?"Activo":"Desactivado"}</td><td><button class="mini-btn" data-worker-edit="${w.id}">Editar</button></td></tr>`).join("");
}
async function loadWorkerAllocations(){if(!user||admin())return;workerAllocations=products.map(p=>({product_id:p.id,quantity_assigned:p.stock,quantity_remaining:p.stock}));renderShopProducts();renderShopCart();await cacheWorkerState();await updatePendingBadge();}
let allocationCurrentWorker="",allocationExisting=[],allocationDraft=new Map(),allocationOtherRemaining=new Map();
function allocationAvailable(productId){const p=products.find(x=>x.id===productId);return Math.max(0,Number(p?.stock||0)-Number(allocationOtherRemaining.get(productId)||0));}
function renderAllocationPicker(){const q=$("allocationSearch").value.trim().toLowerCase();const selected=[...allocationDraft.keys()];const matches=products.filter(p=>p.active!==false&&!selected.includes(p.id)&&allocationAvailable(p.id)>0&&(p.name+" "+(p.sku||"")).toLowerCase().includes(q)).slice(0,30);$("allocationSearchResults").innerHTML=matches.map(p=>{const available=allocationAvailable(p.id);return `<div class="allocation-result"><div><strong>${esc(p.name)}</strong><small>${esc(p.sku||"Sin código")} · Disponible para asignar: ${available}</small></div><button type="button" class="mini-btn" data-allocation-add="${p.id}">＋ Añadir</button></div>`}).join("")||'<p class="muted small">No hay productos disponibles para asignar con esta búsqueda.</p>';$("allocationSelectedCount").textContent=`${allocationDraft.size} productos`;
 $("allocationSelectedList").innerHTML=[...allocationDraft.entries()].map(([id,qty])=>{const p=products.find(x=>x.id===id);if(!p)return"";const available=allocationAvailable(id);const old=allocationExisting.find(x=>x.product_id===id);const sold=Math.max(0,Number(old?.quantity_assigned||0)-Number(old?.quantity_remaining||0));return `<div class="allocation-line"><div class="allocation-line-info"><strong>${esc(p.name)}</strong><small>Stock total: ${p.stock} · Asignado a otros: ${allocationOtherRemaining.get(id)||0} · Disponible para este trabajador: ${available} · Vendido anteriormente: ${sold}</small></div><label class="allocation-qty">Cantidad<input type="number" min="0" max="${available}" step="1" value="${qty}" data-allocation-qty="${id}"></label><button type="button" class="icon-btn allocation-remove" data-allocation-remove="${id}" aria-label="Quitar producto">×</button></div>`}).join("")||'<p class="muted small">Busca y añade los productos que quieras asignar.</p>';
}
async function openAllocation(workerId){const worker=workerRows.find(w=>w.id===workerId);allocationCurrentWorker=workerId;$("allocationWorker").innerHTML=worker?`<option value="${worker.id}">${esc(worker.full_name)}</option>`:"";$("allocationSearch").value="";allocationDraft=new Map();fail("allocationMessage","");const [{data:own,error:ownError},{data:all,error:allError}]=await Promise.all([client.from("worker_stock_allocations").select("product_id,quantity_assigned,quantity_remaining").eq("worker_id",workerId),client.from("worker_stock_allocations").select("worker_id,product_id,quantity_remaining")]);if(ownError||allError){fail("allocationMessage",(ownError||allError).message);return}allocationExisting=own||[];allocationOtherRemaining=new Map();for(const row of all||[]){if(row.worker_id===workerId)continue;allocationOtherRemaining.set(row.product_id,(allocationOtherRemaining.get(row.product_id)||0)+Number(row.quantity_remaining||0));}for(const row of allocationExisting)allocationDraft.set(row.product_id,Number(row.quantity_remaining)||0);renderAllocationPicker();$("allocationDialog").showModal();}
$("allocationSearch").addEventListener("input",renderAllocationPicker);
$("allocationSearchResults").addEventListener("click",e=>{const b=e.target.closest("[data-allocation-add]");if(!b)return;const id=b.dataset.allocationAdd;if(allocationAvailable(id)<=0)return;allocationDraft.set(id,0);renderAllocationPicker();});
$("allocationSelectedList").addEventListener("input",e=>{const input=e.target.closest("[data-allocation-qty]");if(!input)return;const n=Number(input.value),max=allocationAvailable(input.dataset.allocationQty);if(Number.isInteger(n)&&n>=0&&n<=max)allocationDraft.set(input.dataset.allocationQty,n);else fail("allocationMessage",`La cantidad no puede superar las ${max} unidades disponibles para este trabajador.`);});
$("allocationSelectedList").addEventListener("click",e=>{const b=e.target.closest("[data-allocation-remove]");if(!b)return;allocationDraft.delete(b.dataset.allocationRemove);renderAllocationPicker();fail("allocationMessage","");});
$("closeAllocation").onclick=$("cancelAllocation").onclick=()=>$("allocationDialog").close();
$("allocationForm").addEventListener("submit",async e=>{e.preventDefault();if(!allocationDraft.size){fail("allocationMessage","Añade al menos un producto.");return}const items=[...allocationDraft.entries()].map(([product_id,quantity])=>({product_id,quantity}));const invalid=items.find(i=>!Number.isInteger(i.quantity)||i.quantity<0||i.quantity>allocationAvailable(i.product_id));if(invalid){fail("allocationMessage",`Stock insuficiente: solo quedan ${allocationAvailable(invalid.product_id)} unidades disponibles para asignar de ese producto.`);return}const btn=$("saveAllocation");btn.disabled=true;fail("allocationMessage","Guardando todas las asignaciones…");const {data,error}=await client.rpc("admin_set_worker_allocations",{p_worker_id:allocationCurrentWorker,p_items:items});btn.disabled=false;if(error){fail("allocationMessage",error.message);return}toast(`Asignación guardada: ${data||items.length} productos`);$("allocationDialog").close();});
$("manageCategoriesBtn").addEventListener("click",async()=>{await loadCategoriesList();$("categoryDialog").showModal()});
async function loadCategoriesList(){const {data,error}=await client.from("product_categories").select("id,name,active").order("name");if(error){fail("categoryMessage",error.message);return}categories=(data||[]).filter(c=>c.active);$("categoryList").innerHTML=categories.map(c=>`<div class="category-list-row">${esc(c.name)}</div>`).join("")||'<p class="muted small">Todavía no hay categorías.</p>';renderCategoryControls();}
$("closeCategory").onclick=$("cancelCategory").onclick=()=>$("categoryDialog").close();
$("categoryForm").addEventListener("submit",async e=>{e.preventDefault();const name=$("categoryName").value.trim();if(!name)return;const {error}=await client.from("product_categories").insert({name});if(error){fail("categoryMessage",error.message);return}$("categoryName").value="";fail("categoryMessage","Categoría creada");await loadCategoriesList();await loadProducts()});
$("newWorkerBtn").addEventListener("click",()=>{$("workerForm").classList.remove("hidden");fail("workerMessage","");$("workerName").focus()});
$("cancelWorker").addEventListener("click",()=>{$("workerForm").reset();$("workerForm").classList.add("hidden")});
$("workerForm").addEventListener("submit",async e=>{
 e.preventDefault();const btn=$("createWorkerBtn");btn.disabled=true;fail("workerMessage","Creando acceso…");
 try{const {data:{session}}=await client.auth.getSession();const response=await fetch(cfg.url+"/functions/v1/create-worker",{method:"POST",headers:{"Content-Type":"application/json","apikey":cfg.publishableKey,"Authorization":"Bearer "+session.access_token},body:JSON.stringify({full_name:$("workerName").value.trim(),email:$("workerEmail").value.trim(),password:$("workerPassword").value})});const result=await response.json();if(!response.ok)throw new Error(result.error||"No se pudo crear el trabajador");
 $("workerForm").reset();$("workerForm").classList.add("hidden");toast("Trabajador creado. Correo confirmado automáticamente.");await loadWorkers();
 }catch(err){fail("workerMessage",err.message)}finally{btn.disabled=false}
});
function openWorkerEdit(w){$("editWorkerForm").reset();$("editWorkerId").value=w.id;$("editWorkerName").value=w.full_name||"";$("editWorkerEmail").value=w.email||"";$("editWorkerActive").checked=!!w.active;const p=w.worker_permissions||{};$("permCanSell").checked=p.can_sell!==false;$("permCanViewCloseout").checked=p.can_view_own_closeout!==false;$("permCanCountStock").checked=p.can_count_stock!==false;$("permCanCloseDay").checked=p.can_close_day!==false;fail("editWorkerMessage","");$("editWorkerDialog").showModal()}
$("workersBody").addEventListener("click",e=>{const b=e.target.closest("[data-worker-edit]");if(!b)return;const w=workerRows.find(x=>x.id===b.dataset.workerEdit);if(w)openWorkerEdit(w)});
$("closeEditWorker").onclick=$("cancelEditWorker").onclick=()=>$("editWorkerDialog").close();
$("editWorkerForm").addEventListener("submit",async e=>{
 e.preventDefault();const btn=$("saveWorkerBtn");btn.disabled=true;fail("editWorkerMessage","Guardando cambios…");
 try{const {data:{session}}=await client.auth.getSession();const payload={id:$("editWorkerId").value,full_name:$("editWorkerName").value.trim(),email:$("editWorkerEmail").value.trim(),password:$("editWorkerPassword").value,active:$("editWorkerActive").checked,permissions:{can_sell:$("permCanSell").checked,can_view_own_closeout:$("permCanViewCloseout").checked,can_count_stock:$("permCanCountStock").checked,can_close_day:$("permCanCloseDay").checked}};const response=await fetch(cfg.url+"/functions/v1/update-worker",{method:"POST",headers:{"Content-Type":"application/json","apikey":cfg.publishableKey,"Authorization":"Bearer "+session.access_token},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||"No se pudieron guardar los cambios");$("editWorkerDialog").close();toast("Datos del trabajador actualizados");await loadWorkers();
 }catch(err){fail("editWorkerMessage",err.message)}finally{btn.disabled=false}
});
initPromise=init();
})();

// Retroalimentación táctil breve en botones compatibles con vibración.
document.addEventListener("click",e=>{if(e.target.closest("button")&&typeof navigator!="undefined"&&typeof navigator.vibrate==="function"){navigator.vibrate(12);}},true);
