-- Pedidos por QR: restringir lectura en tiempo real al turno titular.
-- Aplicado en Supabase el 2026-11-16. Mantener sincronizado con el proyecto.
create or replace function private.is_current_qr_worker()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_shift smallint;
  v_last_shift smallint;
  v_active smallint;
begin
  if v_uid is null then return false; end if;

  if v_email='dependiente1@eltoque.com' then
    v_shift:=1;
  elsif v_email='dependiente2@eltoque.com' then
    v_shift:=2;
  else
    return false;
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id=v_uid and p.role='worker' and p.active=true
      and coalesce(p.ipv_mode,'shift')='shift'
  ) then
    return false;
  end if;

  select c.shift_no into v_last_shift
  from public.worker_turn_closures c
  order by c.closure_no desc
  limit 1;

  v_active:=case
    when v_last_shift is null then 1
    when v_last_shift=1 then 2
    else 1
  end;
  return v_shift=v_active;
end;
$$;

revoke all on function private.is_current_qr_worker() from public, anon;
grant execute on function private.is_current_qr_worker() to authenticated;

drop policy if exists qr_orders_worker_read on public.qr_orders;
create policy qr_orders_worker_read
on public.qr_orders for select to authenticated
using (private.is_current_qr_worker());

drop policy if exists qr_order_events_worker_read on public.qr_order_events;
-- Realtime Postgres Changes necesita SELECT; RLS limita el acceso al turno titular.
grant select on table public.qr_orders, public.qr_order_events to authenticated;

create policy qr_order_events_worker_read
on public.qr_order_events for select to authenticated
using (
  private.is_current_qr_worker()
  and exists (
    select 1 from public.qr_orders o
    where o.id=qr_order_events.order_id
  )
);
