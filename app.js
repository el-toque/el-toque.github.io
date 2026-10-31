(() => {
"use strict";
const cfg=window.IPV_CONFIG||{};
const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+" CUP";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let client=null,user=null,profile=null,products=[],cart=[],categories=[],shopCategory="all",workerAllocations=[];
// Almacenamiento local duradero para sesión de trabajador, catálogo y ventas pendientes.
const OFFLINE_DB="ipv_digital_offline_v1";
function offlineDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(OFFLINE_DB,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains("records"))db.createObjectStore("records");};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function localGet(key){const db=await offlineDB();return new Promise((resolve,reject)=>{const tx=db.transaction("records","readonly"),r=tx.objectStore("records").get(key);r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error);});}
async function localPut(key,value){const db=await offlineDB();return new Promise((resolve,reject)=>{const tx=db.transaction("records","readwrite");tx.objectStore("records").put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function localDelete(key){const db=await offlineDB();return new Promise((resolve,reject)=>{const tx=db.transaction("records","readwrite");tx.objectStore("records").delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function pendingSales(){return (await localGet("pending_sales"))||[];}
async function updatePendingBadge(){const n=(await pendingSales()).length;const status=$("offlineStatus");if(status){status.textContent=n?`${n} venta(s) pendiente(s) de sincronizar`:(navigator.onLine?"Conectado":"Sin conexión");status.classList.toggle("pending",n>0);}const close=$("closeDaily");if(close){close.disabled=!!activeCloseout||n>0||!navigator.onLine;close.title=n?"Sincroniza las ventas pendientes antes de cerrar":"";}for(const id of ["exportDaily","exportDailyPdf","refreshDaily"]){const b=$(id);if(b){b.disabled=!navigator.onLine;b.title=navigator.onLine?"":"Necesitas conexión para consultar el cuadre actualizado";}}return n;}
async function saveOfflineSale(items,method,code,id=crypto.randomUUID()){
 const queue=await pendingSales();
 if(queue.some(x=>x.id===id))return queue.find(x=>x.id===id);
 // Evita consumir dos veces las mismas unidades asignadas mientras no hay servidor.
 for(const line of items){const allocation=workerAllocations.find(a=>a.product_id===line.product_id);if(!allocation||Number(allocation.quantity_remaining)<Number(line.quantity))throw new Error("Existencia local insuficiente para completar la venta.");}
 const entry={id,items:items.map(x=>({product_id:x.product_id,quantity:x.quantity})),payment_method:method,transfer_code:method==="transfer"?code:null,business_date:localBusinessDate(),created_at:new Date().toISOString(),status:"pending"};
 queue.push(entry);await localPut("pending_sales",queue);
 for(const line of entry.items){const allocation=workerAllocations.find(a=>a.product_id===line.product_id);allocation.quantity_remaining-=line.quantity;}
 await cacheWorkerState();await updatePendingBadge();renderShopProducts();return entry;
}
let syncingPending=false;
async function syncPendingSales(){
 if(syncingPending||!navigator.onLine||!client||!user||admin())return;
 syncingPending=true;
 try{
  let queue=await pendingSales();if(!queue.length){await updatePendingBadge();return;}
  for(const entry of [...queue]){
   if(!navigator.onLine)break;
   const {data,error}=await client.rpc("create_sale",{p_items:entry.items,p_payment_method:entry.payment_method,p_idempotency_key:entry.id,p_notes:null,p_transfer_code:entry.transfer_code,p_business_date:entry.business_date});
   if(error){entry.last_error=error.message;entry.status="error";queue=queue.map(x=>x.id===entry.id?entry:x);await localPut("pending_sales",queue);toast("Una venta sigue pendiente: "+error.message);break;}
   queue=queue.filter(x=>x.id!==entry.id);await localPut("pending_sales",queue);toast("Venta pendiente sincronizada. Folio: "+data);
  }
  await updatePendingBadge();
  if(!(await pendingSales()).length){await loadProducts();await loadWorkerAllocations();await loadDailySales();}
 }catch(e){toast("No se pudo completar la sincronización. Las ventas siguen guardadas en este teléfono.");}
 finally{syncingPending=false;}
}
async function cacheWorkerState(){if(!user||!profile||admin())return;await localPut("worker_profile_"+user.id,profile);await localPut("worker_snapshot_"+user.id,{products,categories,workerAllocations,saved_at:new Date().toISOString()});}
const toast=msg=>{const el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)};
const admin=()=>profile?.role==="admin";
function fail(el,msg){$(el).textContent=msg}
async function init(){
 if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").catch(()=>{});
 window.addEventListener("online",()=>{syncPendingSales();});window.addEventListener("offline",()=>{updatePendingBadge();});
 if(!cfg.url||!cfg.publishableKey){$("sessionLabel").textContent="CONFIGURACIÓN PENDIENTE";$("loginPanel").classList.remove("hidden");fail("loginError","Falta configurar config.js con la URL y la clave publicable del proyecto.");return}
 client=window.supabase.createClient(cfg.url,cfg.publishableKey);
 const {data:{session}}=await client.auth.getSession();
 if(session) {await enter(session.user);if(navigator.onLine)await syncPendingSales();} else showLogin();
 client.auth.onAuthStateChange((_event,session)=>{if(session) setTimeout(async()=>{await enter(session.user);if(navigator.onLine)await syncPendingSales();},0);else showLogin()});
}
function showLogin(){user=null;profile=null;$("appPanel").classList.add("hidden");$("loginPanel").classList.remove("hidden");$("sessionLabel").textContent="SIN SESIÓN"}
async function enter(authUser){
 user=authUser;
 let data=null,error=null;
 if(!navigator.onLine){const cached=await localGet("worker_profile_"+user.id),snapshot=await localGet("worker_snapshot_"+user.id);if(cached?.active&&cached.role==="worker"&&snapshot){profile=cached;products=snapshot.products||[];categories=snapshot.categories||[];workerAllocations=snapshot.workerAllocations||[];renderCategoryControls();renderProducts();renderShopProducts();data=cached;}else{showLogin();fail("loginError","Para entrar sin conexión debes haber iniciado sesión antes en este teléfono y tener el catálogo guardado.");return;}}
 else ({data,error}=await client.from("profiles").select("full_name,role,active").eq("id",user.id).single());
 if(navigator.onLine&&(error||!data||!data.active)){await client.auth.signOut();fail("loginError","Este usuario no tiene un perfil activo. Contacta al administrador.");return;}
 if(navigator.onLine){profile=data;if(!admin())await localPut("worker_profile_"+user.id,data);}
 if(!navigator.onLine&&profile?.role!=="worker"){showLogin();fail("loginError","La administración requiere conexión a internet.");return;}
 data=profile;
$("loginPanel").classList.add("hidden");$("appPanel").classList.remove("hidden");$("sessionLabel").textContent=admin()?"ADMINISTRADOR":"TRABAJADOR";$("welcome").textContent=`Hola, ${data.full_name||user.email} · ${data.role}`;
 $("addBtn").classList.toggle("hidden",!admin());$("manageCategoriesBtn").classList.toggle("hidden",!admin());$("workersNav").classList.toggle("hidden",!admin());$("adminTabs").classList.toggle("hidden",!admin());$("workerTabs").classList.toggle("hidden",admin());
 document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
 if(admin()){document.querySelector('[data-tab="inventory"]').classList.add("active");showSection("inventory");}else{document.querySelector('[data-tab="shop"]').classList.add("active");showSection("shop");}
 await loadProducts();if(admin()){await Promise.all([loadSales(),loadReservations()]);await loadWorkers();}else{await loadWorkerAllocations();await loadDailySales();await cacheWorkerState();await updatePendingBadge();}
}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();fail("loginError","");const {error}=await client.auth.signInWithPassword({email:$("email").value.trim(),password:$("password").value});if(error)fail("loginError",error.message)});
$("logoutBtn").addEventListener("click",()=>client.auth.signOut());
function showSection(tab){["inventory","sales","reservations","workers","shop","daily"].forEach(t=>$(t+"Tab").classList.toggle("hidden",t!==tab));}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{if((admin()&&["shop","daily"].includes(b.dataset.tab))||(!admin()&&["inventory","sales","reservations","workers"].includes(b.dataset.tab)))return;document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));showSection(b.dataset.tab);if(b.dataset.tab==="daily"){loadDailySales();loadCloseoutHistory();}if(b.dataset.tab==="shop")loadProducts();}));
async function loadProducts(){
 if(!navigator.onLine){const snap=user&&!admin()?await localGet("worker_snapshot_"+user.id):null;if(snap){products=snap.products||[];categories=snap.categories||[];workerAllocations=snap.workerAllocations||[];renderCategoryControls();renderProducts();}return;}
 const [{data,error},{data:categoryData,error:categoryError}]=await Promise.all([client.from("products").select("id,sku,name,description,price,stock,active,category_id,image_url").eq("active",true).order("name"),client.from("product_categories").select("id,name,active").eq("active",true).order("name")]);
 if(categoryError){toast("No se pudieron cargar las categorías: "+categoryError.message);return}
 categories=categoryData||[];renderCategoryControls();
 if(error){toast("No se pudo cargar el inventario: "+error.message);return}
 products=data||[];renderProducts();
}
function renderCategoryControls(){const select=$("productCategory");if(select){const chosen=select.value;select.innerHTML='<option value="">Sin categoría</option>'+categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");select.value=chosen;}const filters=$("shopCategoryFilters");if(filters){filters.innerHTML=[`<button type="button" class="category-chip ${shopCategory==="all"?"active":""}" data-category="all">Todas</button>`,...categories.map(c=>`<button type="button" class="category-chip ${shopCategory===c.id?"active":""}" data-category="${c.id}">${esc(c.name)}</button>`)].join("");}}
$("shopCategoryFilters").addEventListener("click",e=>{const b=e.target.closest("[data-category]");if(!b)return;shopCategory=b.dataset.category;renderCategoryControls();renderShopProducts()});
function renderProducts(){
 const q=$("search").value.trim().toLowerCase(),list=products.filter(p=>(p.name+" "+(p.sku||"")).toLowerCase().includes(q));
 $("productCount").textContent=products.length;$("unitCount").textContent=products.reduce((a,p)=>a+p.stock,0);$("stockValue").textContent=money(products.reduce((a,p)=>a+Number(p.price)*p.stock,0));
 $("productsBody").innerHTML=list.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.sku||"—")}</td><td>${money(p.price)}</td><td>${p.stock}</td><td>${admin()?`<button class="mini-btn" data-edit="${p.id}">Editar</button> <button class="mini-btn danger" data-delete="${p.id}">Desactivar</button>`:"—"}</td></tr>`).join("");
 $("inventoryEmpty").classList.toggle("hidden",list.length>0);
 const opts=products.map(p=>`<option value="${p.id}">${esc(p.name)} · ${p.stock} disp.</option>`).join("");
 $("saleProduct").innerHTML=opts;$("reserveProduct").innerHTML=opts;
 if(!admin()){renderShopProducts();renderShopCart();}
}
$("search").addEventListener("input",renderProducts);
$("addBtn").addEventListener("click",()=>openProduct());
$("productsBody").addEventListener("click",async e=>{
 const edit=e.target.closest("[data-edit]"),del=e.target.closest("[data-delete]");
 if(edit){const p=products.find(x=>x.id===edit.dataset.edit);openProduct(p)}
 if(del){const p=products.find(x=>x.id===del.dataset.delete);if(p&&confirm(`¿Desactivar ${p.name}?`)){const {error}=await client.from("products").update({active:false}).eq("id",p.id);if(error)toast(error.message);else{toast("Producto desactivado");await loadProducts()}}}
});
function setProductImagePreview(url){const img=$("productImagePreview"),fallback=$("productImageFallback");if(url){img.src=url;img.classList.remove("hidden");fallback.classList.add("hidden");}else{img.removeAttribute("src");img.classList.add("hidden");fallback.classList.remove("hidden");}}
function openProduct(p=null){$("productForm").reset();renderCategoryControls();$("productCategory").value=p?.category_id||"";$("productId").value=p?.id||"";$("dialogTitle").textContent=p?"Editar producto":"Añadir producto";$("name").value=p?.name||"";$("sku").value=p?.sku||"";$("price").value=p?.price??"";$("stock").value=p?.stock??0;$("description").value=p?.description||"";$("productImageClear").value="0";$("productImageFile").value="";setProductImagePreview(p?.image_url||"");fail("productError","");$("productDialog").showModal()}
$("productImageFile").addEventListener("change",()=>{const file=$("productImageFile").files?.[0];if(file){if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>5*1024*1024){fail("productError","Usa JPG, PNG o WEBP de máximo 5 MB.");$("productImageFile").value="";return;}$("productImageClear").value="0";setProductImagePreview(URL.createObjectURL(file));fail("productError","");}});
$("clearProductImage").addEventListener("click",()=>{$("productImageFile").value="";$("productImageClear").value="1";setProductImagePreview("");});
$("closeDialog").onclick=$("cancelProduct").onclick=()=>$("productDialog").close();
$("productForm").addEventListener("submit",async e=>{
 e.preventDefault();const id=$("productId").value,desiredStock=Number($("stock").value),saveBtn=$("productForm").querySelector('button[type="submit"]');
 if(!Number.isInteger(desiredStock)||desiredStock<0){fail("productError","Las existencias deben ser un número entero igual o mayor que cero.");return}
 const existing=id?products.find(p=>p.id===id):null;
 const row={name:$("name").value.trim(),sku:$("sku").value.trim()||null,price:Number($("price").value),description:$("description").value.trim()||null,category_id:$("productCategory").value||null};
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
$("addCartBtn").onclick=()=>{const id=$("saleProduct").value,qty=Number($("saleQty").value),p=products.find(x=>x.id===id);if(!p||!Number.isInteger(qty)||qty<1){fail("saleMessage","Selecciona producto y cantidad válidos.");return}const existing=cart.find(x=>x.product_id===id);if(existing)existing.quantity+=qty;else cart.push({product_id:id,quantity:qty});fail("saleMessage","");renderCart()};
function renderCart(){ $("cartList").innerHTML=cart.map(i=>{const p=products.find(x=>x.id===i.product_id);return `<div class="cart-row"><span>${esc(p?.name||"Producto")} × ${i.quantity}</span><strong>${money((p?.price||0)*i.quantity)}</strong><button class="mini-btn danger" data-remove="${i.product_id}">Quitar</button></div>`}).join("");$("cartTotal").textContent=money(cart.reduce((s,i)=>s+(products.find(p=>p.id===i.product_id)?.price||0)*i.quantity,0))}
$("cartList").onclick=e=>{const b=e.target.closest("[data-remove]");if(b){cart=cart.filter(i=>i.product_id!==b.dataset.remove);renderCart()}};
$("payment").addEventListener("change",()=>{$("adminTransferCodeWrap").classList.toggle("hidden",$("payment").value!=="transfer");if($("payment").value!=="transfer")$("adminTransferCode").value=""});
$("sellBtn").onclick=async()=>{if(!cart.length){fail("saleMessage","Añade al menos un producto.");return}const method=$("payment").value,code=$("adminTransferCode").value.trim();if(method==="transfer"&&!code){fail("saleMessage","Introduce el código de la transferencia.");$("adminTransferCode").focus();return}$("sellBtn").disabled=true;fail("saleMessage","Procesando venta…");const {data,error}=await client.rpc("create_sale",{p_items:cart,p_payment_method:method,p_idempotency_key:crypto.randomUUID(),p_notes:null,p_transfer_code:method==="transfer"?code:null,p_business_date:localBusinessDate()});$("sellBtn").disabled=false;if(error){fail("saleMessage",error.message);return}cart=[];$("adminTransferCode").value="";renderCart();fail("saleMessage","Venta registrada correctamente. Folio: "+data);await loadProducts();await loadSales()};

let shopBounceProductId=null;
function renderShopProducts(){const bounceId=shopBounceProductId;shopBounceProductId=null;const q=( $("shopSearch")?.value||"").trim().toLowerCase();const allowed=admin()?products:products.filter(p=>(workerAllocations.find(a=>a.product_id===p.id)?.quantity_remaining||0)>0);const available=allowed.filter(p=>(admin()?p.stock:(workerAllocations.find(a=>a.product_id===p.id)?.quantity_remaining||0))>0);const list=available.filter(p=>(shopCategory==="all"||p.category_id===shopCategory)&&(p.name+" "+(p.sku||"")+" "+(p.description||"")).toLowerCase().includes(q));$("shopProducts").innerHTML=list.map(p=>{const selected=cart.find(i=>i.product_id===p.id)?.quantity||0;return `<article class="shop-card ${selected?"has-selected":""}"><span class="shop-selected-count ${selected?"is-visible":""} ${selected&&bounceId===p.id?"do-bounce":""}" aria-label="${selected} seleccionados">${selected}</span><div class="shop-card-mark">${p.image_url?`<img class="shop-product-image" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove();this.parentElement.innerHTML='<span>✦</span><small>EL TOQUE</small>'">`:`<span>✦</span><small>EL TOQUE</small>`}</div><div class="shop-card-info"><h3>${esc(p.name)}</h3><p>${esc(p.description||"Disponible para entrega")}</p></div><div class="shop-card-bottom"><strong>${money(p.price)}</strong><span class="shop-stock">${admin()?p.stock:(workerAllocations.find(a=>a.product_id===p.id)?.quantity_remaining||0)} disp.</span></div><button class="primary" data-shop-add="${p.id}">＋ Añadir al pedido</button></article>`}).join("");$("shopEmpty").classList.toggle("hidden",list.length>0);$("shopEmpty").textContent=available.length===0?"No hay productos disponibles en este momento.":"No encontramos productos con esa búsqueda.";}
$("shopSearch").addEventListener("input",renderShopProducts);
$("shopProducts").addEventListener("click",e=>{const b=e.target.closest("[data-shop-add]");if(!b)return;const p=products.find(x=>x.id===b.dataset.shopAdd);const available=admin()?p?.stock:(workerAllocations.find(a=>a.product_id===p?.id)?.quantity_remaining||0);if(!p||available<1)return;const line=cart.find(x=>x.product_id===p.id);if(line){if(line.quantity>=available){fail("shopMessage","No hay más unidades disponibles.");return}line.quantity++;}else cart.push({product_id:p.id,quantity:1});fail("shopMessage","");renderShopCart();shopBounceProductId=p.id;renderShopProducts();});
function renderShopCart(){const count=cart.reduce((n,i)=>n+i.quantity,0);$("shopCartCount").textContent=count;$("shopCartList").innerHTML=cart.map(i=>{const p=products.find(x=>x.id===i.product_id);return `<div class="cart-row"><span>${esc(p?.name||"Producto")} × ${i.quantity}</span><strong>${money((p?.price||0)*i.quantity)}</strong><div class="quantity-actions"><button class="mini-btn" data-shop-minus="${i.product_id}" aria-label="Quitar una unidad">− 1</button><button class="mini-btn danger" data-shop-remove="${i.product_id}">Quitar todo</button></div></div>`}).join("");$("shopCartTotal").textContent=money(cart.reduce((a,i)=>a+(products.find(p=>p.id===i.product_id)?.price||0)*i.quantity,0));$("shopOrderEmpty").classList.toggle("hidden",cart.length>0);$("shopSellBtn").disabled=cart.length===0;}
$("shopCartList").addEventListener("click",e=>{const minus=e.target.closest("[data-shop-minus]"),remove=e.target.closest("[data-shop-remove]");if(minus){const line=cart.find(i=>i.product_id===minus.dataset.shopMinus);if(line){line.quantity--;if(line.quantity<=0)cart=cart.filter(i=>i!==line);}renderShopCart();renderShopProducts();return}if(remove){cart=cart.filter(i=>i.product_id!==remove.dataset.shopRemove);renderShopCart();renderShopProducts();}});
function showShopOrder(show){$("shopCatalogView").classList.toggle("hidden",show);$("shopOrderView").classList.toggle("hidden",!show);if(show)renderShopCart();}
$("viewOrderBtn").addEventListener("click",()=>showShopOrder(true));
$("backToCatalog").addEventListener("click",()=>showShopOrder(false));
$("shopPayment").addEventListener("change",()=>{$("transferCodeWrap").classList.toggle("hidden",$("shopPayment").value!=="transfer");if($("shopPayment").value!=="transfer")$("transferCode").value="";});
$("shopSellBtn").addEventListener("click",async()=>{if(!cart.length){fail("shopMessage","Agrega al menos un producto al carrito.");return}const method=$("shopPayment").value,code=$("transferCode").value.trim();if(method==="transfer"&&!code){fail("shopMessage","Introduce el código de la transferencia antes de confirmar.");$("transferCode").focus();return}const btn=$("shopSellBtn");btn.disabled=true;if(!navigator.onLine){try{const entry=await saveOfflineSale(cart,method,code);cart=[];$("transferCode").value="";renderShopCart();showShopOrder(false);fail("shopMessage","Pendiente de sincronizar. Se guardó en este teléfono.");toast("Venta guardada sin conexión");}catch(e){fail("shopMessage","No se pudo guardar localmente. No cierres esta página.");}finally{btn.disabled=false;}return;}fail("shopMessage","Procesando venta…");const id=crypto.randomUUID();const {data,error}=await client.rpc("create_sale",{p_items:cart,p_payment_method:method,p_idempotency_key:id,p_notes:null,p_transfer_code:method==="transfer"?code:null,p_business_date:localBusinessDate()});btn.disabled=false;if(error){if(!navigator.onLine||/fetch|network|failed to fetch|load failed/i.test(error.message||"")){try{await saveOfflineSale(cart,method,code,id);cart=[];renderShopCart();showShopOrder(false);fail("shopMessage","Pendiente de sincronizar. Se guardó en este teléfono.");}catch(e){fail("shopMessage","No se pudo guardar la venta localmente.");}return;}fail("shopMessage",error.message);return;}cart=[];$("transferCode").value="";renderShopCart();showShopOrder(false);fail("shopMessage","Venta confirmada. Folio: "+data);toast("Venta registrada y existencias descontadas");await loadProducts();await loadWorkerAllocations();await loadDailySales();});
$("refreshShop").onclick=loadProducts;
function localBusinessDate(d=new Date()){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`;}
let dailyExportRows=[];
let dailyStockRows=[];
let dailyStockCounts=new Map();
let activeCloseout=null;
async function loadDailySales(){if(!user||admin())return;if(!navigator.onLine){$("dailyCloseStatus").textContent="Sin conexión: el cuadre requiere datos actualizados del servidor. Las ventas guardadas siguen pendientes de sincronizar.";await updatePendingBadge();return;}const now=new Date(),start=new Date(now.getFullYear(),now.getMonth(),now.getDate()),end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);$("dailyDate").textContent=start.toLocaleDateString("es-ES",{weekday:"long",year:"numeric",month:"long",day:"numeric"});const {data,error}=await client.from("sales").select("id,total,payment_method,transfer_code,created_at,status,sale_items(product_id,quantity,unit_price,products(name))").eq("status","completed").gte("created_at",start.toISOString()).lt("created_at",end.toISOString()).order("created_at",{ascending:false});if(error){toast("No se pudo cargar el cuadre: "+error.message);return}const dayKey=localBusinessDate(start);
 const {data:closed,error:closeErr}=await client.from("daily_closeouts").select("id,business_date,sales_count,cash_total,transfer_total,grand_total,closed_at").eq("business_date",dayKey).maybeSingle();
 if(closeErr){toast("No se pudo consultar el cierre: "+closeErr.message);return}
 activeCloseout=closed||null;
 const closeBtn=$("closeDaily");closeBtn.disabled=!!activeCloseout||!navigator.onLine;closeBtn.textContent=activeCloseout?"Jornada cerrada":"Cerrar y bloquear día";
 $("dailyCloseStatus").textContent=activeCloseout?`Cierre confirmado el ${new Date(activeCloseout.closed_at).toLocaleString("es-ES")}. Esta jornada está bloqueada.`:"Jornada abierta: al cerrar se guardará una copia definitiva y no se podrán registrar más ventas con esta fecha.";
 const {data:counts,error:countsErr}=await client.from("worker_daily_stock_counts").select("product_id,expected_quantity,physical_quantity,counted_at").eq("worker_id",user.id).eq("business_date",dayKey);
 if(countsErr){toast("No se pudo cargar el conteo físico: "+countsErr.message);return;}
 dailyStockCounts=new Map((counts||[]).map(c=>[c.product_id,c]));
 const soldByProduct=new Map();
 for(const sale of (data||[]))for(const item of (sale.sale_items||[]))soldByProduct.set(item.product_id,(soldByProduct.get(item.product_id)||0)+Number(item.quantity||0));
 dailyStockRows=workerAllocations.map(a=>{const p=products.find(x=>x.id===a.product_id);if(!p)return null;const expected=Number(a.quantity_remaining)||0;const sold=Number(a.quantity_assigned||0)-expected;const saved=dailyStockCounts.get(a.product_id);return {product_id:a.product_id,name:p.name,assigned:Number(a.quantity_assigned)||expected+sold,sold,expected,physical:saved?Number(saved.physical_quantity):null,difference:saved?Number(saved.physical_quantity)-expected:null};}).filter(Boolean);
 renderDailyStockCounts();
 const rows=data||[];dailyExportRows=rows;const cash=rows.filter(x=>x.payment_method==="cash").reduce((a,x)=>a+Number(x.total),0),transfer=rows.filter(x=>x.payment_method==="transfer").reduce((a,x)=>a+Number(x.total),0),total=cash+transfer;$("dailyCount").textContent=rows.length;$("dailyCash").textContent=money(cash);$("dailyTransfer").textContent=money(transfer);$("dailyTotal").textContent=money(total);$("dailySalesBody").innerHTML=rows.map(x=>{const items=(x.sale_items||[]).map(i=>`${esc(i.products?.name||"Producto")} × ${Number(i.quantity)||0}`).join("<br>")||"—";return `<tr><td>${new Date(x.created_at).toLocaleTimeString("es-ES")}</td><td>${items}</td><td>${money(x.total)}</td><td>${x.payment_method==="cash"?"CUP":"Transferencia"}</td><td>${esc(x.transfer_code||"—")}</td></tr>`}).join("");$("dailyEmpty").classList.toggle("hidden",rows.length>0);await updatePendingBadge();}
function renderDailyStockCounts(){
 const body=$("dailyStockBody");if(!body)return;
 body.innerHTML=dailyStockRows.map(r=>{const value=r.physical===null?"":r.physical;const diff=r.difference===null?"Pendiente":(r.difference>0?"+":"")+r.difference;return `<tr><td>${esc(r.name)}</td><td>${r.assigned}</td><td>${r.sold}</td><td><strong>${r.expected}</strong></td><td><input class="daily-physical-input" type="number" min="0" step="1" inputmode="numeric" data-stock-count="${r.product_id}" value="${value}" aria-label="Conteo físico de ${esc(r.name)}"></td><td>${diff}</td></tr>`}).join("")||'<tr><td colspan="6">No tienes productos asignados.</td></tr>';
 const pending=dailyStockRows.filter(r=>r.physical===null).length;
 $("dailyStockStatus").textContent=pending?`${pending} producto(s) pendiente(s) de contar.`:"Conteo físico guardado para todos los productos.";
}
$("dailyStockBody").addEventListener("change",async e=>{
 const input=e.target.closest("[data-stock-count]");if(!input)return;const quantity=Number(input.value);if(!Number.isInteger(quantity)||quantity<0){toast("Introduce una cantidad entera igual o mayor que cero.");return;}
 const row=dailyStockRows.find(r=>r.product_id===input.dataset.stockCount);if(!row)return;input.disabled=true;
 const {data,error}=await client.from("worker_daily_stock_counts").upsert({worker_id:user.id,business_date:localBusinessDate(),product_id:row.product_id,expected_quantity:row.expected,physical_quantity:quantity,counted_at:new Date().toISOString()},{onConflict:"worker_id,business_date,product_id"}).select("product_id,expected_quantity,physical_quantity,counted_at").single();
 input.disabled=false;if(error){toast("No se pudo guardar el conteo: "+error.message);return;}
 dailyStockCounts.set(row.product_id,data);row.physical=quantity;row.difference=quantity-row.expected;renderDailyStockCounts();toast("Conteo físico guardado.");
});
$("closeDaily").onclick=async()=>{
 if(!navigator.onLine){toast("Necesitas conexión para cerrar la jornada.");return}
 if(await updatePendingBadge()){toast("Primero sincroniza todas las ventas pendientes.");return}
 if(activeCloseout){toast("Esta jornada ya está cerrada.");return}
 if(!confirm("¿Confirmas el cierre de tu jornada? Se guardará el detalle y no podrás registrar más ventas con la fecha de hoy."))return;
 const now=new Date(),start=new Date(now.getFullYear(),now.getMonth(),now.getDate()),end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
 const btn=$("closeDaily");btn.disabled=true;btn.textContent="Cerrando…";
 const {data,error}=await client.rpc("close_daily_register",{p_business_date:localBusinessDate(start),p_start:start.toISOString(),p_end:end.toISOString()});
 if(error){btn.disabled=false;btn.textContent="Cerrar y bloquear día";toast("No se pudo cerrar la jornada: "+error.message);return}
 toast("Jornada cerrada y guardada. Folio: "+data);await loadDailySales();await loadCloseoutHistory();
};
async function loadCloseoutHistory(){
 const {data,error}=await client.from("daily_closeouts").select("id,business_date,sales_count,cash_total,transfer_total,grand_total,closed_at").order("business_date",{ascending:false}).limit(30);
 if(error){toast("No se pudo cargar el historial de cierres: "+error.message);return}
 $("closeoutHistoryBody").innerHTML=(data||[]).map(c=>`<tr><td>${esc(c.business_date)}</td><td>${new Date(c.closed_at).toLocaleString("es-ES")}</td><td>${c.sales_count}</td><td>${money(c.cash_total)}</td><td>${money(c.transfer_total)}</td><td>${money(c.grand_total)}</td><td>${esc(c.id)}</td></tr>`).join("");
 $("closeoutHistoryEmpty").classList.toggle("hidden",!!(data||[]).length);
}
$("refreshDaily").onclick=async()=>{await loadDailySales();await loadCloseoutHistory();};
$("exportDaily").onclick=()=>{
 if(!dailyExportRows.length){toast("No hay ventas de hoy para exportar.");return}
 if(!window.XLSX){toast("No se pudo cargar el módulo de Excel. Comprueba tu conexión e inténtalo de nuevo.");return}
 const detail=[];
 for(const sale of dailyExportRows){
  const items=sale.sale_items||[];
  if(items.length){for(const item of items){detail.push({Fecha:new Date(sale.created_at).toLocaleDateString("es-ES"),Hora:new Date(sale.created_at).toLocaleTimeString("es-ES"),Producto:item.products?.name||"Producto",Cantidad:Number(item.quantity)||0,"Precio unitario":Number(item.unit_price)||0,"Importe línea":(Number(item.unit_price)||0)*(Number(item.quantity)||0),"Total de venta":Number(sale.total)||0,"Forma de pago":sale.payment_method==="cash"?"CUP":"Transferencia","Código de transferencia":sale.transfer_code||"—",Folio:sale.id})}}
  else detail.push({Fecha:new Date(sale.created_at).toLocaleDateString("es-ES"),Hora:new Date(sale.created_at).toLocaleTimeString("es-ES"),Producto:"—",Cantidad:0,"Precio unitario":0,"Importe línea":0,"Total de venta":Number(sale.total)||0,"Forma de pago":sale.payment_method==="cash"?"CUP":"Transferencia","Código de transferencia":sale.transfer_code||"—",Folio:sale.id});
 }
 const cash=dailyExportRows.filter(x=>x.payment_method==="cash").reduce((a,x)=>a+Number(x.total),0);
 const transfer=dailyExportRows.filter(x=>x.payment_method==="transfer").reduce((a,x)=>a+Number(x.total),0);
 const accountName=profile?.full_name||user?.email||"Cuenta sin nombre";
 const accountEmail=user?.email||"—";
 const accountRole=profile?.role||"trabajador";
 const summary=[{"Concepto":"Cuenta","Valor":accountName},{"Concepto":"Correo de la cuenta","Valor":accountEmail},{"Concepto":"Tipo de cuenta","Valor":accountRole},{"Concepto":"Fecha de exportación","Valor":new Date().toLocaleString("es-ES")},{"Concepto":"Cantidad de ventas","Valor":dailyExportRows.length},{"Concepto":"Total CUP","Valor":cash},{"Concepto":"Total Transferencias","Valor":transfer},{"Concepto":"Total vendido","Valor":cash+transfer}];
 const stockDetail=dailyStockRows.map(r=>({Producto:r.name,Asignado:r.assigned,Vendido:r.sold,"Debe quedar":r.expected,"Conteo físico":r.physical===null?"Pendiente":r.physical,Diferencia:r.difference===null?"Pendiente":r.difference}));
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(detail),"Detalle de ventas");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summary),"Resumen");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(stockDetail),"Conteo físico");
 const stamp=new Date().toISOString().slice(0,10);XLSX.writeFile(wb,`Cuadre_IPV_${stamp}.xlsx`);toast("Archivo Excel preparado para guardar en tu teléfono.");
};


$("exportDailyPdf").onclick=()=>{
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
 doc.text("Ventas: "+dailyExportRows.length+"    Total CUP: "+cash.toFixed(2)+" CUP    Total Transferencias: "+transfer.toFixed(2)+" CUP    Total vendido: "+(cash+transfer).toFixed(2)+" CUP",14,37);
 const body=[];
 for(const sale of dailyExportRows){
  const when=new Date(sale.created_at);
  const products=(sale.sale_items||[]).map(i=>(i.products?.name||"Producto")+" × "+(Number(i.quantity)||0)).join(", ")||"—";
  body.push([when.toLocaleTimeString("es-ES"),products,Number(sale.total||0).toFixed(2)+" CUP",sale.payment_method==="cash"?"CUP":"Transferencia",sale.transfer_code||"—",String(sale.id||"")]);
 }
 if(typeof doc.autoTable!=="function"){toast("No se pudo preparar la tabla PDF. Comprueba tu conexión.");return}
 doc.autoTable({startY:43,head:[["Hora","Productos y cantidades","Importe","Pago","Código transferencia","Folio"]],body,styles:{fontSize:8,cellPadding:2,overflow:"linebreak"},headStyles:{fillColor:[7,85,164]},columnStyles:{1:{cellWidth:75},5:{cellWidth:45}}});
 let nextY=(doc.lastAutoTable?.finalY||43)+10;doc.setFontSize(13);doc.text("Conteo físico de existencias",14,nextY);if(typeof doc.autoTable==="function"){doc.autoTable({startY:nextY+4,head:[["Producto","Asignado","Vendido","Debe quedar","Conteo físico","Diferencia"]],body:dailyStockRows.map(r=>[r.name,String(r.assigned),String(r.sold),String(r.expected),r.physical===null?"Pendiente":String(r.physical),r.difference===null?"Pendiente":String(r.difference)]),styles:{fontSize:8,cellPadding:2},headStyles:{fillColor:[7,85,164]}});}doc.save("Cuadre_IPV_"+new Date().toISOString().slice(0,10)+".pdf");toast("PDF preparado para guardar en tu teléfono.");
};

let allAdminSales=[];
async function loadSales(){
 if(!user)return;
 const {data,error}=await client.from("sales").select("id,worker_id,total,payment_method,transfer_code,status,created_at,profiles(full_name),sale_items(quantity,unit_price,products(name))").order("created_at",{ascending:false}).limit(1000);
 if(error){toast("Ventas: "+error.message);return}
 allAdminSales=data||[];
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
 rows.forEach(s=>{const id=s.worker_id||"unknown",g=groups.get(id)||{name:s.profiles?.full_name||"Trabajador",count:0,cash:0,transfer:0,total:0};g.count++;g.total+=Number(s.total)||0;if(s.payment_method==="transfer")g.transfer+=Number(s.total)||0;else g.cash+=Number(s.total)||0;groups.set(id,g);});
 $("salesWorkerSummary").innerHTML=[...groups.values()].map(g=>'<article class="stat"><span>'+esc(g.name)+'</span><strong>'+g.count+' ventas</strong><small>CUP: '+money(g.cash)+' · Transferencias: '+money(g.transfer)+' · Total: '+money(g.total)+'</small></article>').join("")||'<p class="muted small">No hay ventas en este período.</p>';
 $("salesBody").innerHTML=rows.map(s=>{
  const items=(s.sale_items||[]).map(i=>esc(i.products?.name||"Producto")+" × "+(Number(i.quantity)||0)).join("<br>")||"—";
  return '<tr><td>'+new Date(s.created_at).toLocaleString("es-ES")+'</td><td>'+esc(s.profiles?.full_name||"Trabajador")+'</td><td>'+items+'</td><td>'+money(s.total)+'</td><td>'+esc(({cash:"CUP",card:"Tarjeta",transfer:"Transferencia"})[s.payment_method]||s.payment_method||"—")+'</td><td>'+esc(s.transfer_code||"—")+'</td><td>'+esc(s.status||"—")+'</td></tr>';
 }).join("");
 $("salesEmpty").classList.toggle("hidden",rows.length>0);
}
$("refreshSales").onclick=loadSales;
["salesFrom","salesTo","salesWorker"].forEach(id=>$(id).addEventListener("change",renderAdminSales));
$("reserveBtn").onclick=async()=>{const qty=Number($("reserveQty").value),hours=Number($("reserveHours").value);if(!$("reserveProduct").value||!Number.isInteger(qty)||qty<1){fail("reserveMessage","Selecciona producto y cantidad válidos.");return}const {data,error}=await client.rpc("create_stock_reservation",{p_product_id:$("reserveProduct").value,p_quantity:qty,p_customer_phone:$("customerPhone").value.trim(),p_hours:hours});if(error){fail("reserveMessage",error.message);return}fail("reserveMessage","Reserva creada: "+data);await loadProducts();await loadReservations()};
async function loadReservations(){if(!user)return;const {data,error}=await client.from("stock_reservations").select("id,product_id,quantity,customer_phone,expires_at,created_at,status,products(name)").eq("status","active").order("created_at",{ascending:false});if(error){toast("Reservas: "+error.message);return}$("reservationsBody").innerHTML=(data||[]).map(r=>`<tr><td>${new Date(r.created_at).toLocaleString("es-US")}</td><td>${esc(r.products?.name||"Producto")}</td><td>${r.quantity}</td><td>${esc(r.customer_phone)}</td><td>${new Date(r.expires_at).toLocaleString("es-US")}</td><td><button class="mini-btn danger" data-release="${r.id}">Liberar</button></td></tr>`).join("")}
$("reservationsBody").onclick=async e=>{const b=e.target.closest("[data-release]");if(!b)return;const {data,error}=await client.rpc("release_stock_reservation",{p_reservation_id:b.dataset.release});if(error){toast(error.message);return}toast(data?"Reserva liberada":"La reserva ya no estaba activa");await loadProducts();await loadReservations()};
$("refreshReservations").onclick=loadReservations;

let workerRows=[];
async function loadWorkers(){
 const {data:{session}}=await client.auth.getSession();
 const response=await fetch(cfg.url+"/functions/v1/list-workers",{method:"POST",headers:{"Content-Type":"application/json","apikey":cfg.publishableKey,"Authorization":"Bearer "+session.access_token},body:"{}"});
 const result=await response.json();if(!response.ok){toast(result.error||"No se pudo cargar el equipo");return}
 workerRows=result.workers||[];$("workersEmpty")?.classList.toggle("hidden",workerRows.length>0);
 $("workersBody").innerHTML=workerRows.map(w=>`<tr><td>${esc(w.full_name)}</td><td>${esc(w.email||"—")}</td><td>${w.active?"Activo":"Desactivado"}</td><td><button class="mini-btn" data-worker-allocation="${w.id}">Asignar stock</button> <button class="mini-btn" data-worker-edit="${w.id}">Editar</button></td></tr>`).join("");
}
async function loadWorkerAllocations(){if(!user||admin())return;if(!navigator.onLine){const snap=await localGet("worker_snapshot_"+user.id);workerAllocations=snap?.workerAllocations||workerAllocations;renderShopProducts();renderShopCart();await updatePendingBadge();return;}const {data,error}=await client.from("worker_stock_allocations").select("product_id,quantity_assigned,quantity_remaining").eq("worker_id",user.id);if(error){toast("No se pudieron cargar tus existencias asignadas: "+error.message);workerAllocations=[];}else workerAllocations=data||[];renderShopProducts();renderShopCart();await cacheWorkerState();await updatePendingBadge();}
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
function openWorkerEdit(w){$("editWorkerForm").reset();$("editWorkerId").value=w.id;$("editWorkerName").value=w.full_name||"";$("editWorkerEmail").value=w.email||"";$("editWorkerActive").checked=!!w.active;fail("editWorkerMessage","");$("editWorkerDialog").showModal()}
$("workersBody").addEventListener("click",e=>{const a=e.target.closest("[data-worker-allocation]"),b=e.target.closest("[data-worker-edit]");if(a){openAllocation(a.dataset.workerAllocation);return}if(!b)return;const w=workerRows.find(x=>x.id===b.dataset.workerEdit);if(w)openWorkerEdit(w)});
$("closeEditWorker").onclick=$("cancelEditWorker").onclick=()=>$("editWorkerDialog").close();
$("editWorkerForm").addEventListener("submit",async e=>{
 e.preventDefault();const btn=$("saveWorkerBtn");btn.disabled=true;fail("editWorkerMessage","Guardando cambios…");
 try{const {data:{session}}=await client.auth.getSession();const payload={id:$("editWorkerId").value,full_name:$("editWorkerName").value.trim(),email:$("editWorkerEmail").value.trim(),password:$("editWorkerPassword").value,active:$("editWorkerActive").checked};const response=await fetch(cfg.url+"/functions/v1/update-worker",{method:"POST",headers:{"Content-Type":"application/json","apikey":cfg.publishableKey,"Authorization":"Bearer "+session.access_token},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||"No se pudieron guardar los cambios");$("editWorkerDialog").close();toast("Datos del trabajador actualizados");await loadWorkers();
 }catch(err){fail("editWorkerMessage",err.message)}finally{btn.disabled=false}
});
init();
})();

// Retroalimentación táctil breve en botones compatibles con vibración.
document.addEventListener("click",e=>{if(e.target.closest("button")&&typeof navigator!="undefined"&&typeof navigator.vibrate==="function"){navigator.vibrate(12);}},true);
