(()=>{"use strict";
const cfg=window.IPV_CONFIG||{},$=id=>document.getElementById(id),money=n=>new Intl.NumberFormat("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+" CUP";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fallback="../icons/icon-192.png";let db=null,items=[],cart=new Map(),whatsapp="",delivery="",bouncedProductId=null,lastRenderedCount=0,screenToRestore="catalog";
const STORE_STATE_KEY="eltoque_store_state_v1";
function saveStoreState(){try{localStorage.setItem(STORE_STATE_KEY,JSON.stringify({cart:[...cart.entries()],screen:screenToRestore}));}catch(e){console.warn("No se pudo guardar el pedido localmente:",e)}}
function restoreStoreState(){try{const saved=JSON.parse(localStorage.getItem(STORE_STATE_KEY)||"null");if(!saved)return; if(Array.isArray(saved.cart))cart=new Map(saved.cart.filter(x=>Array.isArray(x)&&x.length===2&&typeof x[0]==="string"&&Number.isInteger(x[1])&&x[1]>0&&x[1]<=999));if(["catalog","cart","details"].includes(saved.screen))screenToRestore=saved.screen;}catch(e){console.warn("No se pudo recuperar el pedido guardado:",e)}}
function toast(s){const e=$("toast");e.textContent=s;e.classList.add("show");setTimeout(()=>e.classList.remove("show"),2400)}
function showCartItems(){ screenToRestore="cart";saveStoreState(); $("cartStepbar").hidden=false; $("customerScreen").classList.remove("is-open"); $("carrito").classList.add("is-open"); $("carrito").scrollTop=0; document.body.classList.add("checkout-visible"); document.body.classList.remove("customer-screen-visible"); }
function showOrderDetails(){ if(!cart.size)return; screenToRestore="details";saveStoreState(); $("cartStepbar").hidden=true; $("carrito").classList.remove("is-open"); $("customerScreen").classList.add("is-open"); document.body.classList.remove("checkout-visible"); document.body.classList.add("customer-screen-visible"); $("customerScreen").scrollTop=0; $("buyerName").focus(); }
function openCart(){if(!cart.size)return;showCartItems();$("carrito").classList.add("is-open");document.body.classList.add("checkout-visible");$("closeCart").focus();}
function closeCart(){screenToRestore="catalog";saveStoreState();$("customerScreen").classList.remove("is-open");document.body.classList.remove("customer-screen-visible");$("carrito").classList.remove("is-open");document.body.classList.remove("checkout-visible");}
async function start(){
 restoreStoreState();
 if(!cfg.url||!cfg.publishableKey||!window.supabase){$("catalogStatus").textContent="No disponible";$("catalog").innerHTML='<p class="empty">No se pudo conectar con el catálogo. Inténtalo más tarde.</p>';return}
 db=window.supabase.createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:false,autoRefreshToken:false}});
 await Promise.allSettled([loadCatalog(),loadConfig()]);
 cart=new Map([...cart.entries()].filter(([id])=>items.some(p=>p.id===id)));
 renderCart();
 if(cart.size&&screenToRestore==="cart")showCartItems();else if(cart.size&&screenToRestore==="details")showOrderDetails();else{screenToRestore="catalog";saveStoreState();}
 $("search").addEventListener("input",renderCatalog);
 const searchPanel=$("searchPanel"),searchToggle=$("searchToggle"),searchInput=$("search");
 function closeSearch(){searchPanel.hidden=true;searchToggle.setAttribute("aria-expanded","false");searchToggle.focus();searchInput.value="";renderCatalog();}
 searchToggle.addEventListener("click",()=>{const opening=searchPanel.hidden;searchPanel.hidden=!opening;searchToggle.setAttribute("aria-expanded",String(opening));if(opening)searchInput.focus();else closeSearch();});
 $("closeSearch").addEventListener("click",closeSearch);
 searchInput.addEventListener("keydown",e=>{if(e.key==="Escape")closeSearch();});
 $("catalog").addEventListener("click",e=>{const b=e.target.closest("[data-add]");if(!b)return;const p=items.find(x=>x.id===b.dataset.add);if(!p||!p.is_available)return;const qty=cart.get(p.id)||0;if(qty>=999){toast("Has alcanzado el límite de unidades por pedido.");return;}cart.set(p.id,qty+1);screenToRestore=screenToRestore==="details"?"details":screenToRestore==="cart"?"cart":"catalog";saveStoreState();bouncedProductId=p.id;renderCart();});
 $("cartItems").addEventListener("click",e=>{const b=e.target.closest("[data-cart-action]");if(!b)return;const id=b.dataset.id,n=cart.get(id)||0;if(b.dataset.cartAction==="plus"){const p=items.find(x=>x.id===id);if(!p||!p.is_available||n>=999){toast("Has alcanzado el límite de unidades por pedido.");return;}cart.set(id,n+1);}else if(b.dataset.cartAction==="minus"){if(n<=1)cart.delete(id);else cart.set(id,n-1)}else cart.delete(id);saveStoreState();renderCart();});
 $("submitOrder").addEventListener("click",submitOrder);$("continueOrder").addEventListener("click",showOrderDetails);$("backToItems").addEventListener("click",showCartItems);$("openCart").addEventListener("click",openCart);$("headerCart").addEventListener("click",e=>{e.preventDefault();openCart()});$("closeCart").addEventListener("click",closeCart);
}
async function loadCatalog(){
 try{
  const {data,error}=await db.rpc("store_public_catalog");
  if(error)throw error;
  items=Array.isArray(data)?data:[];
  $("catalogStatus").textContent=items.length+" productos";
  renderCatalog();
 }catch(error){
  console.error("Error cargando catálogo:",error);
  $("catalogStatus").textContent="Error de catálogo";
  $("catalog").innerHTML='<p class="empty">No pudimos cargar los productos. Vuelve a intentarlo.</p>';
 }
}
async function loadConfig(){
 try{
  const {data,error}=await db.rpc("store_public_config");
  if(error)throw error;
  if(data?.length){whatsapp=data[0].whatsapp_number||"";delivery=data[0].delivery_information||""}
 }catch(error){console.warn("No se pudo cargar la configuración de entrega:",error)}
 $("deliveryInfo").textContent=delivery||"Coordina los detalles de entrega al confirmar tu pedido.";
}
function renderCatalog(){const q=$("search").value.trim().toLowerCase(),list=items.filter(p=>(p.name+" "+(p.description||"")).toLowerCase().includes(q));$("catalog").innerHTML=list.length?list.map(p=>'<article class="product product-row"><div class="product-body"><h3>'+esc(p.name)+'</h3>'+(p.description?'<p>'+esc(p.description)+'</p>':'<p class="product-note">Producto disponible en nuestra tienda</p>')+'<div class="product-bottom"><span class="price">'+money(p.store_price)+'</span></div></div><div class="product-image">'+(!p.is_available?'<span class="stock-tag">Agotado</span>':'')+'<img src="'+esc(p.image_url||fallback)+'" alt="'+esc(p.name)+'" loading="lazy" onerror="this.src=\''+fallback+'\'">'+(p.is_available?'<button class="add add-icon" data-add="'+p.id+'" aria-label="Agregar '+esc(p.name)+'" title="Agregar al pedido"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>':'')+'</div></article>').join(""):'<p class="empty">No hay productos publicados que coincidan con tu búsqueda.</p>';decorateCatalog()}
function decorateCatalog(){for(const p of items){const qty=cart.get(p.id)||0;if(!qty)continue;const button=$("catalog").querySelector('[data-add="'+p.id+'"]');if(!button)continue;button.classList.add("has-count");button.innerHTML='<span class="add-count" aria-label="'+qty+' unidades seleccionadas">'+qty+'</span>';if(bouncedProductId===p.id){button.classList.remove("bounce");void button.offsetWidth;button.classList.add("bounce");}}bouncedProductId=null}

function renderCart(){
 const rows=[...cart.entries()].map(([id,qty])=>({p:items.find(x=>x.id===id),qty})).filter(x=>x.p),count=rows.reduce((n,x)=>n+x.qty,0),total=rows.reduce((n,x)=>n+x.qty*Number(x.p.store_price),0);
 $("headerCount").textContent=count;$("bottomCount").textContent=count;$("bottomCountWord").textContent=count===1?"producto":"productos";if(count!==lastRenderedCount){const counter=$("bottomCount");counter.classList.remove("bump");void counter.offsetWidth;counter.classList.add("bump");lastRenderedCount=count;}$("bottomTotal").textContent=money(total);$("cartCount").textContent=count+" artículo"+(count===1?"":"s");$("total").textContent=money(total);$("detailsTotal").textContent=money(total);const cartBar=$("openCart");if(count===0){cartBar.hidden=true;cartBar.classList.remove("is-visible");cartBar.style.setProperty("display","none","important");cartBar.style.setProperty("opacity","0","important");cartBar.style.setProperty("visibility","hidden","important");cartBar.style.setProperty("pointer-events","none","important");}else{cartBar.hidden=false;cartBar.classList.add("is-visible");cartBar.style.setProperty("display","flex","important");cartBar.style.setProperty("opacity","1","important");cartBar.style.setProperty("visibility","visible","important");cartBar.style.setProperty("pointer-events","auto","important");}cartBar.setAttribute("aria-hidden",count===0?"true":"false");cartBar.tabIndex=count===0?-1:0;
 $("cartItems").innerHTML=rows.length?rows.map(({p,qty})=>`<div class="cart-row"><img src="${esc(p.image_url||fallback)}" alt=""><div class="cart-product-info"><strong class="cart-product-name">${esc(p.name)}</strong><div class="cart-product-divider"></div><p class="cart-product-description">${esc(p.description||"")}</p><small class="cart-product-price">${money(p.store_price)}</small></div><div class="qty"><button data-cart-action="minus" data-id="${p.id}" aria-label="Restar">−</button><b>${qty}</b><button data-cart-action="plus" data-id="${p.id}" aria-label="Sumar" ${qty>=999?"disabled":""}>+</button></div><button class="remove" data-cart-action="remove" data-id="${p.id}">Quitar</button></div>`).join(""):'<p class="muted">Todavía no has añadido productos.</p>';
 $("submitOrder").disabled=!rows.length;$("continueOrder").disabled=!rows.length;if(!rows.length){$("cartStepbar").hidden=false;$("customerScreen").classList.remove("is-open");document.body.classList.remove("customer-screen-visible");}renderCatalog();
}
async function submitOrder(){
 const rows=[...cart.entries()].map(([product_id,quantity])=>({product_id,quantity}));if(!rows.length)return;
 const fields=["buyerName","buyerPhone","recipientName","recipientPhone","recipientAddress"];for(const id of fields){if(!$(id).value.trim()){$(id).focus();$("formMessage").textContent="Completa todos los datos para continuar.";return}}
 const button=$("submitOrder");button.disabled=true;$("formMessage").textContent="Guardando tu pedido…";
 let whatsappWindow=null;try{if(whatsapp)whatsappWindow=window.open("about:blank","_blank");}catch(_){}
 const {data,error}=await db.rpc("store_create_order",{p_placed_by_name:$("buyerName").value.trim(),p_placed_by_phone:$("buyerPhone").value.trim(),p_recipient_name:$("recipientName").value.trim(),p_recipient_address:$("recipientAddress").value.trim(),p_recipient_phone:$("recipientPhone").value.trim(),p_items:rows});
 if(error){if(whatsappWindow)whatsappWindow.close();$("formMessage").textContent=error.message||"No se pudo guardar el pedido.";button.disabled=false;return}
 const order=data?.[0];if(!order){if(whatsappWindow)whatsappWindow.close();$("formMessage").textContent="No recibimos confirmación del registro. Contacta con El Toque antes de repetir el pedido.";button.disabled=false;return}
 cart.clear();screenToRestore="catalog";saveStoreState();renderCart();closeCart();$("formMessage").textContent="Pedido #"+order.order_number+" registrado correctamente.";
 if(order.whatsapp_number){const phone=String(order.whatsapp_number).replace(/\D/g,"");const url="https://wa.me/"+phone+"?text="+encodeURIComponent(order.whatsapp_message||"Pedido #"+order.order_number+" de El Toque");if(whatsappWindow)whatsappWindow.location=url;else window.location.href=url;toast("Pedido guardado. Revisa WhatsApp y pulsa Enviar.");}
 else {if(whatsappWindow)whatsappWindow.close();toast("Pedido guardado. El administrador debe configurar el WhatsApp de la tienda.");}
 button.disabled=false;
}
start().catch(e=>{$("catalogStatus").textContent="Error";$("catalog").innerHTML='<p class="empty">No se pudo iniciar la tienda. Inténtalo de nuevo.</p>';console.error(e)});
})();