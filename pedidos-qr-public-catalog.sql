-- Reduce public metadata returned by the QR catalog.
-- Customers receive availability as a boolean, never stock quantities,
-- active worker identity, shift number, session number or business date.
create or replace function public.qr_public_catalog()
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_last public.worker_turn_closures%rowtype;
  v_shift smallint;
  v_session integer;
  v_worker uuid;
  v_business_date date := (now() at time zone 'America/Havana')::date;
  v_items jsonb;
  v_settings jsonb;
begin
  select * into v_last from public.worker_turn_closures order by closure_no desc limit 1;
  if v_last.id is null then v_shift:=1;v_session:=1;
  else v_shift:=case when v_last.shift_no=1 then 2 else 1 end;v_session:=v_last.session_no+1;end if;
  select p.id into v_worker from auth.users u join public.profiles p on p.id=u.id
    where lower(u.email)=case when v_shift=1 then 'dependiente1@eltoque.com' else 'dependiente2@eltoque.com' end
      and p.role='worker' and p.active=true and coalesce(p.ipv_mode,'shift')='shift' limit 1;
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
  return jsonb_build_object('available',true,'items',v_items,'settings',coalesce(v_settings,'{}'::jsonb));
end;
$function$;
