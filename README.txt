IPV Digital - Tienda, cuadre y cierres diarios

Incluye:
- Tienda para trabajadores y venta con varios productos.
- Pago en CUP o Transferencia con código obligatorio.
- Descuento automático de inventario al confirmar la venta.
- Cuadre diario con detalle de productos, cantidades y códigos.
- Exportación del cuadre a Excel (.xlsx) y PDF.
- Cierre diario persistente por trabajador, con totales y copia del detalle.
- Bloqueo de nuevas ventas para el trabajador en la fecha ya cerrada.
- Historial de los últimos 30 cierres.

IMPORTANTE:
La migración de base de datos para daily_closeouts, la función close_daily_register y la protección de create_sale ya fue aplicada al proyecto Supabase conectado.
Publicar esta carpeta en el mismo sitio Netlify existente (yl-eltoque).
No crear un sitio nuevo.

MODO SIN CONEXIÓN (actualización)
- El teléfono debe abrir IPV Digital al menos una vez con internet e iniciar sesión como trabajador para guardar el perfil, catálogo y existencias asignadas.
- Después, si pierde internet, puede confirmar ventas desde la tienda. Se guardan localmente en IndexedDB y se muestran como pendientes de sincronizar.
- Al volver la conexión, la aplicación intenta sincronizarlas automáticamente usando el mismo identificador único de cada venta para evitar duplicados.
- No borres los datos del navegador ni desinstales/borres los datos del sitio mientras existan ventas pendientes. Si el teléfono se pierde o se limpia su almacenamiento, esas ventas locales podrían perderse.
- El cuadre y el cierre diario requieren conexión. El cierre queda deshabilitado mientras haya ventas pendientes.
- El acceso sin conexión solo es posible en un teléfono que ya tenga sesión y datos guardados; no permite el primer inicio de sesión sin internet.
- El stock asignado debe configurarse desde Administración para cada trabajador antes de usar la tienda. En la base conectada actualmente no hay asignaciones creadas; por eso la tienda de los trabajadores no mostrará productos hasta asignarlos.

PUBLICACIÓN
Sube el contenido de esta carpeta al proyecto Netlify existente `yl-eltoque`, sustituyendo los archivos de la versión anterior. No crees un sitio nuevo. Esta entrega no se publica automáticamente.

VALIDACIÓN
JavaScript revisado con `node --check`; HTML revisado por estructura e IDs duplicados/referencias; ZIP comprobado con `unzip -t`. La prueba final de modo avión, reinicio del navegador y sincronización debe hacerse en un teléfono antes de usar ventas reales.
