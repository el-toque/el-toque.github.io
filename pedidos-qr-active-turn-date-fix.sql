-- Keep QR catalog, admin preview and order validation on the active shift's
-- inventory business date. A shift may remain open across Havana midnight.
-- The date is resolved from inventory rows for the active worker/shift/session.

CREATE OR REPLACE FUNCTION public.qr_admin_catalog_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_last public.worker_turn_closures%rowtype;
  v_shift smallint;
  v_session integer;
  v_worker uuid;
  v_date date;
  v_settings jsonb;
  v_items jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Solo el administrador puede consultar la configuración del catálogo QR'; end if;
  select * into v_last from public.worker_turn_closures order by closure_no desc limit 1;
  if v_last.id is null then v_shift:=1;v_session:=1;
  else v_shift:=case when v_last.shift_no=1 then 2 else 1 end;v_session:=v_last.session_no+1;end if;
  select p.id into v_worker from auth.users u join public.profiles p on p.id=u.id
    where lower(u.email)=case when v_shift=1 then 'dependiente1@eltoque.com' else 'dependiente2@eltoque.com' end
      and p.role='worker' and p.active=true and coalesce(p.ipv_mode,'shift')='shift' limit 1;
  select coalesce(max(i.business_date),(now() at time zone 'America/Havana')::date) into v_date
    from public.worker_turn_inventory_items i where i.worker_id=v_worker and i.shift_no=v_shift and i.session_no=v_session;
  select to_jsonb(s) into v_settings from public.qr_catalog_settings s where s.id=true;
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_key',lower(btrim(i.product_name)),'name',i.product_name,'description',p.description,'category',c.name,
    'price',i.price,'promotional_price',qps.promotional_price,'featured',coalesce(qps.featured,false),
    'featured_order',coalesce(qps.featured_order,0),'image_url',coalesce(img.image_url,p.image_url)
  ) order by i.row_no),'[]'::jsonb)
  into v_items
  from public.worker_turn_inventory_items i
  join public.products p on lower(btrim(p.name))=lower(btrim(i.product_name)) and p.active=true
  left join public.product_categories c on c.id=p.category_id
  left join public.qr_product_settings qps on qps.product_key=lower(btrim(i.product_name))
  left join public.worker_turn_product_images img on img.product_key=lower(btrim(i.product_name))
  where i.worker_id=v_worker and i.shift_no=v_shift and i.business_date=v_date and i.session_no=v_session;
  return jsonb_build_object('settings',coalesce(v_settings,'{}'::jsonb),'items',v_items,'shift_no',v_shift,'session_no',v_session);
end;
$function$;

CREATE OR REPLACE FUNCTION public.qr_public_catalog()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_last public.worker_turn_closures%rowtype;
  v_shift smallint;
  v_session integer;
  v_worker uuid;
  v_business_date date;
  v_items jsonb;
  v_settings jsonb;
begin
  select * into v_last from public.worker_turn_closures order by closure_no desc limit 1;
  if v_last.id is null then v_shift:=1;v_session:=1;
  else v_shift:=case when v_last.shift_no=1 then 2 else 1 end;v_session:=v_last.session_no+1;end if;
  select p.id into v_worker from auth.users u join public.profiles p on p.id=u.id
    where lower(u.email)=case when v_shift=1 then 'dependiente1@eltoque.com' else 'dependiente2@eltoque.com' end
      and p.role='worker' and p.active=true and coalesce(p.ipv_mode,'shift')='shift' limit 1;
  select coalesce(max(i.business_date),(now() at time zone 'America/Havana')::date) into v_business_date
    from public.worker_turn_inventory_items i where i.worker_id=v_worker and i.shift_no=v_shift and i.session_no=v_session;
  select to_jsonb(s) into v_settings from public.qr_catalog_settings s where s.id=true;
  if v_worker is null or coalesce((v_settings->>'enabled')::boolean,false)=false then
    return jsonb_build_object('available',false,'items','[]'::jsonb,'settings',coalesce(v_settings,'{}'::jsonb));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'turn_item_id',i.id,'product_key',lower(btrim(i.product_name)),'name',i.product_name,
    'description',p.description,'category',c.name,
    'price',case when qps.promotional_price is not null and qps.promotional_price<i.price then qps.promotional_price else i.price end,
    'regular_price',i.price,'promotional',qps.promotional_price is not null and qps.promotional_price<i.price,
    'image_url',coalesce(img.image_url,p.image_url),
    'available',greatest(i.final_qty
      - coalesce((select sum(vi.quantity)::integer from public.worker_turn_voucher_items vi join public.worker_turn_vouchers vh on vh.id=vi.voucher_id
        where vh.status='pending' and lower(btrim(vi.product_name))=lower(btrim(i.product_name))),0)
      - coalesce((select sum(qi.quantity)::integer from public.qr_order_items qi join public.qr_orders qo on qo.id=qi.order_id
        where qo.status in ('new','preparing','ready') and qi.product_key=lower(btrim(i.product_name))),0),0)>0,
    'featured',coalesce(qps.featured,false),'featured_order',coalesce(qps.featured_order,0)
  ) order by (greatest(i.final_qty
      - coalesce((select sum(vi.quantity)::integer from public.worker_turn_voucher_items vi join public.worker_turn_vouchers vh on vh.id=vi.voucher_id
        where vh.status='pending' and lower(btrim(vi.product_name))=lower(btrim(i.product_name))),0)
      - coalesce((select sum(qi.quantity)::integer from public.qr_order_items qi join public.qr_orders qo on qo.id=qi.order_id
        where qo.status in ('new','preparing','ready') and qi.product_key=lower(btrim(i.product_name))),0),0)>0) desc,
      coalesce(qps.featured_order,0),i.row_no),'[]'::jsonb)
  into v_items
  from public.worker_turn_inventory_items i
  join public.products p on lower(btrim(p.name))=lower(btrim(i.product_name)) and p.active=true
  left join public.product_categories c on c.id=p.category_id and c.active=true
  left join public.worker_turn_product_images img on img.product_key=lower(btrim(i.product_name))
  left join public.qr_product_settings qps on qps.product_key=lower(btrim(i.product_name))
  where i.worker_id=v_worker and i.shift_no=v_shift and i.business_date=v_business_date and i.session_no=v_session
    and exists(select 1 from public.qr_catalog_settings s where s.id=true and s.enabled=true);
  -- The public response intentionally omits the active worker, shift, session and business date.
  return jsonb_build_object('available',true,'items',v_items,'settings',coalesce(v_settings,'{}'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION public.qr_submit_order(p_customer_name text, p_observations text, p_items jsonb, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_last public.worker_turn_closures%rowtype;
  v_shift smallint;
  v_session integer;
  v_worker uuid;
  v_business_date date;
  v_order_id uuid;
  v_order_no bigint;
  v_token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  v_total numeric(14,2):=0;
  v_line record;
  v_item public.worker_turn_inventory_items%rowtype;
  v_reserved integer;
  v_unit_price numeric(14,2);
  v_description text;
  v_image text;
  v_settings public.qr_catalog_settings%rowtype;
begin
  if p_idempotency_key is null then raise exception 'Solicitud no válida'; end if;
  if nullif(btrim(p_customer_name),'') is null or length(btrim(p_customer_name))>120 then raise exception 'Introduce tu nombre para enviar el pedido'; end if;
  if p_observations is not null and length(p_observations)>500 then raise exception 'Las observaciones no pueden superar 500 caracteres'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Añade al menos un producto'; end if;
  select * into v_settings from public.qr_catalog_settings where id=true;
  if not found or not v_settings.enabled then raise exception 'Los pedidos QR no están disponibles temporalmente'; end if;

  perform pg_advisory_xact_lock(hashtext('worker_turn_closure_sequence'));
  perform pg_advisory_xact_lock(hashtext('worker_turn_vouchers_stock'));
  select * into v_last from public.worker_turn_closures order by closure_no desc limit 1;
  if v_last.id is null then v_shift:=1;v_session:=1;
  else v_shift:=case when v_last.shift_no=1 then 2 else 1 end;v_session:=v_last.session_no+1;end if;
  select p.id into v_worker from auth.users u join public.profiles p on p.id=u.id
    where lower(u.email)=case when v_shift=1 then 'dependiente1@eltoque.com' else 'dependiente2@eltoque.com' end
      and p.role='worker' and p.active=true and coalesce(p.ipv_mode,'shift')='shift' limit 1;
  select coalesce(max(i.business_date),(now() at time zone 'America/Havana')::date) into v_business_date
    from public.worker_turn_inventory_items i where i.worker_id=v_worker and i.shift_no=v_shift and i.session_no=v_session;
  if v_worker is null then raise exception 'No se pudo validar el turno titular del mostrador'; end if;

  select id into v_order_id from public.qr_orders where idempotency_key=p_idempotency_key;
  if v_order_id is not null then
    return (select jsonb_build_object('id',o.id,'order_number',o.order_number,'shift_no',o.shift_no,
      'order_code',(case when o.shift_no=1 then 'T1-QR-' else 'T2-QR-' end)||lpad(o.order_number::text,5,'0'),
      'status',o.status,'total',o.total,'tracking_token',o.tracking_token,'duplicate',true)
      from public.qr_orders o where o.id=v_order_id);
  end if;

  for v_line in
    select (x->>'turn_item_id')::uuid item_id,sum((x->>'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) x group by (x->>'turn_item_id')::uuid
  loop
    if v_line.quantity<=0 or v_line.quantity>999 then raise exception 'Cantidad no válida'; end if;
    select * into v_item from public.worker_turn_inventory_items i
      where i.id=v_line.item_id and i.worker_id=v_worker and i.shift_no=v_shift
        and i.business_date=v_business_date and i.session_no=v_session for update;
    if not found then raise exception 'Uno de los productos ya no está disponible en el turno actual'; end if;
    if not exists(select 1 from public.products p where lower(btrim(p.name))=lower(btrim(v_item.product_name)) and p.active=true) then
      raise exception 'El producto % ya no está disponible en el catálogo',v_item.product_name;
    end if;
    select coalesce(sum(vi.quantity),0)::integer into v_reserved from public.worker_turn_voucher_items vi
      join public.worker_turn_vouchers vh on vh.id=vi.voucher_id
      where vh.status='pending' and lower(btrim(vi.product_name))=lower(btrim(v_item.product_name));
    v_reserved:=v_reserved+coalesce((select sum(qi.quantity)::integer from public.qr_order_items qi
      join public.qr_orders qo on qo.id=qi.order_id where qo.status in ('new','preparing','ready')
      and qi.product_key=lower(btrim(v_item.product_name))),0);
    if v_item.final_qty-v_reserved<v_line.quantity then raise exception 'No hay existencias suficientes de %',v_item.product_name; end if;
    select case when qps.promotional_price is not null and qps.promotional_price<v_item.price then qps.promotional_price else v_item.price end
      into v_unit_price from (select 1) x left join public.qr_product_settings qps on qps.product_key=lower(btrim(v_item.product_name));
    v_total:=v_total+v_unit_price*v_line.quantity;
  end loop;

  update public.qr_order_sequences set last_number=last_number+1 where shift_no=v_shift returning last_number into v_order_no;
  if v_order_no is null then raise exception 'La numeración QR del turno no está inicializada'; end if;
  insert into public.qr_orders(order_number,shift_no,business_date,session_no,created_by,customer_name,observations,status,total,
    idempotency_key,tracking_token_hash,tracking_token)
  values(v_order_no,v_shift,v_business_date,v_session,v_worker,btrim(p_customer_name),nullif(btrim(p_observations),''),'new',
    v_total,p_idempotency_key,md5(v_token),v_token) returning id into v_order_id;

  for v_line in
    select (x->>'turn_item_id')::uuid item_id,sum((x->>'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) x group by (x->>'turn_item_id')::uuid
  loop
    select * into v_item from public.worker_turn_inventory_items where id=v_line.item_id;
    select p.description into v_description from public.products p
      where lower(btrim(p.name))=lower(btrim(v_item.product_name)) and p.active=true limit 1;
    select img.image_url into v_image from public.worker_turn_product_images img where img.product_key=lower(btrim(v_item.product_name)) limit 1;
    select case when qps.promotional_price is not null and qps.promotional_price<v_item.price then qps.promotional_price else v_item.price end
      into v_unit_price from (select 1) x left join public.qr_product_settings qps on qps.product_key=lower(btrim(v_item.product_name));
    insert into public.qr_order_items(order_id,source_turn_item_id,product_key,product_name,product_description,image_url,quantity,unit_price)
    values(v_order_id,v_item.id,lower(btrim(v_item.product_name)),v_item.product_name,v_description,v_image,v_line.quantity,v_unit_price);
  end loop;
  insert into public.qr_order_events(order_id,event_type,actor_type,details)
  values(v_order_id,'created','customer',jsonb_build_object('shift_no',v_shift,'session_no',v_session));
  return jsonb_build_object('id',v_order_id,'order_number',v_order_no,
    'order_code',(case when v_shift=1 then 'T1-QR-' else 'T2-QR-' end)||lpad(v_order_no::text,5,'0'),
    'shift_no',v_shift,'status','new','total',v_total,'tracking_token',v_token,'duplicate',false);
end;
$function$;
