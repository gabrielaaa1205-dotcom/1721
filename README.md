# CIANSE SAC — Sistema de Control de Almacén y Producción

Aplicación web para reemplazar el control manual en Excel (CRP - Control de
Recepción de Productos y CDP - Control de Despacho de Productos) por un
sistema con base de datos real, trazabilidad, control de stock por
lote/ubicación y prevención de inconsistencias de inventario — y que además
incorpora un módulo de **Producción / Maquila** para controlar productividad,
personal y estándares de las operaciones diarias (ver más abajo).

> **Notas de esta entrega (mejoras 2026):** catálogos de clientes y productos
> ahora son abiertos (buscar o crear al vuelo, SKU manual para productos
> nuevos); las ubicaciones de almacén se explican con un sistema cardinal
> Zona/Pasillo/Rack/Nivel/Posición; recepciones tienen filtros de fecha con
> atajos ("esta semana", "mes pasado", etc.) y paginación; y se agregó por
> completo el módulo de Producción / Maquila (actividades, operarios, mesas,
> productividad, estándares, KPIs y alertas). Nada de lo anterior fue
> eliminado: recepción, despacho, kardex e inventario funcionan igual que
> antes.

La base de datos que se entrega **ya viene cargada con tus datos reales**,
importados desde tus archivos `prueba crp.xlsx` y `prueba cdp.xlsb`:

- 40 clientes
- 1,536 productos
- 641 recepciones (2,036 líneas)
- 368 despachos (1,487 líneas)
- 3,528 movimientos de inventario

No necesitas volver a importar nada para empezar a usarla, aunque el módulo
de importación sigue disponible por si más adelante quieres cargar archivos
adicionales o una actualización de estos mismos Excel.

## Requisitos

- Python 3.10 o superior (no requiere internet ni instalar paquetes
  adicionales de terceros más allá de los indicados abajo)
- Para importar archivos `.xlsb` (formato binario de Excel) hace falta tener
  LibreOffice instalado en la máquina donde corras el servidor. Los archivos
  `.xlsx` normales no lo necesitan.

## Instalación y ejecución

```bash
cd wms-app/backend
pip install -r requirements.txt
python3 app.py
```

Por defecto el servidor arranca en `http://localhost:5050`. Puedes cambiar el
puerto con la variable de entorno `PORT`, por ejemplo:

```bash
PORT=8080 python3 app.py
```

Abre esa dirección en el navegador. El frontend (HTML/CSS/JS) lo sirve el
mismo servidor Flask, no hace falta ningún paso adicional de "build".

## Usuarios de acceso

| Rol | Correo | Contraseña |
|---|---|---|
| Administrador (acceso total) | admin@almacen.com | admin123 |
| Supervisor | supervisor@almacen.com | super123 |

Desde el módulo **Usuarios** (solo visible para el rol Administrador) puedes
crear el resto de usuarios de tu equipo (recepción, almacén, picking,
consulta) y asignarles el rol correspondiente. Te recomiendo cambiar estas
dos contraseñas por defecto apenas la pongan en uso real.

Los roles disponibles y lo que pueden hacer:

- **ADMIN**: acceso total, incluida gestión de usuarios y auditoría.
- **SUPERVISOR**: todo excepto gestión de usuarios; puede aprobar ajustes de
  inventario físico.
- **RECEPCION**: registra recepciones, inspección de calidad y ubicación.
- **ALMACEN**: gestiona ubicaciones, movimientos internos y ubicación de
  mercancía.
- **PICKING**: ejecuta órdenes de picking y despachos.
- **CONSULTA**: solo lectura (dashboard, reportes, trazabilidad).

## Qué incluye la aplicación

- **Dashboard**: KPIs en tiempo real (unidades recibidas/despachadas hoy,
  stock disponible, productos por vencer a 15/30/60/90 días, alertas).
- **Recepciones**: registro de ingreso de mercancía, inspección de calidad
  (conforme/observado/defectuoso) y ubicación (putaway) sugerida
  automáticamente según capacidad libre.
- **Stock**: consulta de inventario disponible por producto, lote y
  ubicación, con vencimientos y trazabilidad FEFO (primero en expirar,
  primero en salir).
- **Despachos**: reserva de stock por FEFO/FIFO, picking, verificación y
  cierre de despacho, con control de que no se despache más de lo
  disponible.
- **Almacén**: mapa de zonas, racks, niveles y ubicaciones, con capacidad y
  ocupación.
- **Inventario físico**: conteos cíclicos con generación automática de
  diferencias y aplicación de ajustes al aprobar.
- **Trazabilidad**: historial completo de un lote o producto, desde su
  recepción hasta su despacho.
- **Reportes**: exportación a Excel (.xlsx) de existencias, movimientos,
  recepciones y despachos.
- **Auditoría**: registro de quién cambió qué y cuándo, con motivo.
- **Importador Excel**: valida el archivo, muestra un resumen de filas
  válidas/con advertencia/con error/duplicadas antes de escribir nada, y
  solo confirma la importación cuando tú lo apruebas.

## Cómo se resolvieron los problemas del proceso en Excel

Este sistema aplica las mejoras identificadas en el análisis previo:

- El stock **nunca se edita directamente**: se calcula siempre a partir del
  historial completo de movimientos (recepción → calidad → ubicación →
  reserva → despacho), por lo que no puede quedar descuadrado entre pestañas
  distintas como pasaba en los archivos de Excel.
- Cada producto/lote tiene una **ubicación física validada contra
  capacidad**, evitando sobreocupar racks.
- Los nombres de cliente y SKU se validan contra catálogos, evitando los
  casos de clientes duplicados o mal escritos (como "TASA"/"ALMACEN"
  apareciendo dentro de otras hojas) que se veían en el Excel.
- Las fechas se validan al ingresar (evitando errores como la fecha inválida
  "24/047/2026" encontrada en tus datos).
- El sistema de picking usa FEFO automáticamente, reduciendo mermas por
  vencimiento.
- Todo queda con auditoría: quién hizo cada recepción, ajuste o despacho, y
  cuándo.

## Estructura del proyecto

```
wms-app/
├── backend/
│   ├── app.py              # punto de entrada Flask
│   ├── schema.sql           # esquema completo de la base de datos
│   ├── auth.py               # autenticación y permisos por rol
│   ├── db.py                  # acceso a SQLite
│   ├── seed_demo.py            # datos iniciales (roles, almacén, usuarios)
│   ├── services/                # lógica de negocio (stock, FEFO, etc.)
│   ├── blueprints/                # endpoints de la API REST (/api/...)
│   └── importer/                   # importador de Excel (CRP/CDP)
├── frontend/                # interfaz web (HTML/CSS/JS, sin frameworks)
└── data/
    └── wms.db              # base de datos SQLite (ya incluye tus datos reales)
```

## Notas técnicas

- Base de datos: SQLite (archivo único en `data/wms.db`), suficiente para el
  volumen actual de un almacén. Si en el futuro el equipo crece mucho o se
  necesita acceso concurrente muy alto, se puede migrar a PostgreSQL
  reutilizando el mismo `schema.sql` como punto de partida.
- No se requiere ningún servicio externo ni conexión a internet para operar
  el día a día.
- Se recomienda hacer respaldos periódicos copiando el archivo
  `data/wms.db`.
