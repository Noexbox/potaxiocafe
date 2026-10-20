
select current_database(), current_user, version();

--Tabla Clientes
create table clientes (
id_cliente serial primary key,
nombre varchar(50) not null,
apellido varchar(50) not null,
telefono varchar(20) not null,
correo varchar(100) not null
);

--Tabla productos
create table productos (
id_producto serial primary key,
nombre varchar(80) not null,
precio numeric(6, 2) not null,
disponible boolean default true
);

--Tabla pedidos
create table pedidos (
id_pedido serial primary key,
id_cliente integer not null,
fecha timestamp default now(),
estado varchar(20) default 'pendiente', --Pendiente/en preparación. Listo/entregado
notas text,
total numeric(8, 2) default 0, --Lo calcula un trigger
foreign key (id_cliente) references clientes(id_cliente)
);

--Tabla detalle pedido
create table detalle_pedido (
id_detalle serial primary key,
id_pedido integer not null,
id_producto integer not null,
cantidad int not null check (cantidad > 0),
precio_unitario numeric(6,2) not null,
subtotal numeric(8, 2) generated always as (cantidad * precio_unitario) stored, -- = cantidad * precio calculado por un trigger
foreign key (id_pedido) references pedidos(id_pedido),
foreign key (id_producto) references productos(id_producto)
);

-- =====================================================
-- TRIGGER 1: Precio unitario seguro
-- =====================================================
-- Nunca confiamos en un precio que venga del cliente/formulario.
-- Antes de insertar una línea de detalle, este trigger reemplaza
-- precio_unitario con el precio real que está guardado en
-- "productos" en ese momento, sin importar qué valor haya llegado.
-- Ajustado a la convención id_producto / id_pedido / id_detalle.
 
CREATE OR REPLACE FUNCTION fijar_precio_real()
RETURNS TRIGGER AS $$
BEGIN
    SELECT precio INTO NEW.precio_unitario
    FROM productos
    WHERE id_producto = NEW.id_producto;
 
    IF NEW.precio_unitario IS NULL THEN
        RAISE EXCEPTION 'El producto % no existe o no tiene precio', NEW.id_producto;
    END IF;
 
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
 
CREATE TRIGGER trg_fijar_precio_real
BEFORE INSERT ON detalle_pedido
FOR EACH ROW
EXECUTE FUNCTION fijar_precio_real();

-- =====================================================
-- TRIGGER 2: Recalcular el total del pedido
-- =====================================================
-- Cada vez que se inserta, actualiza o elimina una línea en
-- detalle_pedido, este trigger vuelve a sumar todos los subtotales
-- de ese pedido y actualiza pedidos.total. Así el total nunca
-- depende de que el backend "recuerde" recalcularlo.
 
CREATE OR REPLACE FUNCTION actualizar_total_pedido()
RETURNS TRIGGER AS $$
DECLARE
    v_id_pedido INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_id_pedido := OLD.id_pedido;
    ELSE
        v_id_pedido := NEW.id_pedido;
    END IF;
 
    UPDATE pedidos
    SET total = COALESCE(
        (SELECT SUM(subtotal) FROM detalle_pedido WHERE id_pedido = v_id_pedido),
        0
    )
    WHERE id_pedido = v_id_pedido;
 
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
 
CREATE TRIGGER trg_total_insert
AFTER INSERT ON detalle_pedido
FOR EACH ROW
EXECUTE FUNCTION actualizar_total_pedido();
 
CREATE TRIGGER trg_total_update
AFTER UPDATE ON detalle_pedido
FOR EACH ROW
EXECUTE FUNCTION actualizar_total_pedido();
 
CREATE TRIGGER trg_total_delete
AFTER DELETE ON detalle_pedido
FOR EACH ROW
EXECUTE FUNCTION actualizar_total_pedido();
 
-- =====================================================
-- TRIGGER 3: No permitir productos no disponibles
-- =====================================================
-- Evita que se agregue al pedido un producto marcado como
-- no disponible (ej. se acabó el café frío ese día).
 
CREATE OR REPLACE FUNCTION validar_disponibilidad()
RETURNS TRIGGER AS $$
DECLARE
    v_disponible BOOLEAN;
BEGIN
    SELECT disponible INTO v_disponible
    FROM productos
    WHERE id_producto = NEW.id_producto;
 
    IF v_disponible IS FALSE THEN
        RAISE EXCEPTION 'El producto % no está disponible en este momento', NEW.id_producto;
    END IF;
 
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
 
CREATE TRIGGER trg_validar_disponibilidad
BEFORE INSERT ON detalle_pedido
FOR EACH ROW
EXECUTE FUNCTION validar_disponibilidad();

--=============================================================
--Datos de prueba
--=============================================================

--Datos de productos
INSERT INTO productos (nombre, precio, disponible) VALUES
('Espresso', 2.00, true),
('Latte', 2.75, true),
('Café frío', 3.00, false); --no disponible a propósito para probar trigger 3

INSERT INTO productos (nombre, precio, disponible) VALUES
('Pastel del día', 2.50, true),
('Capuchino', 2.00, true);
--Verifica los IDs que se generaron:
SELECT * FROM productos;

--Datos de clientes
INSERT INTO clientes (nombre, apellido, telefono, correo) VALUES
('Ana', 'Martínez', '7000-1111', 'ana@correo.com');
 
SELECT * FROM clientes;

--Datos de pedidos
--no ponemos "total": el trigger lo va a llenar solo.
INSERT INTO pedidos (id_cliente, notas)
VALUES (1, 'Sin azúcar, para llevar');
 
SELECT * FROM pedidos;
-- En este punto total debe salir en 0.00 todavía, porque no hay
-- ninguna línea en detalle_pedido.

-- DATOS DETALLE_PEDIDO PRUEBA TRIGGER 1 Y 2
-- Insertamos 2 espressos e "inventamos" un precio_unitario absurdo
-- (99.99) a propósito, para comprobar que el trigger lo ignora
-- y pone el precio real de "productos" (2.00).
 
INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario)
VALUES (1, 1, 2, 99.99);
 
SELECT * FROM detalle_pedido;
-- precio_unitario debe salir 2.00 (no 99.99) -> trigger 1 funcionando
-- subtotal debe salir 4.00 (2 x 2.00)
 
SELECT id_pedido, total FROM pedidos WHERE id_pedido = 1;
-- total debe salir 4.00 -> trigger 2 funcionando

-- AGREGAR OTRA LÍNEA AL PEDIDO
INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario)
VALUES (1, 2, 1, 0);  -- 1 latte, precio_unitario en 0 (también será ignorado)
 
SELECT id_pedido, total FROM pedidos WHERE id_pedido = 1;
-- total debe subir a 6.75  (4.00 del espresso + 2.75 del latte)


-- PRUEBA TRIGGER 3 (DISPONIBILIDAD)
INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario)
VALUES (1, 3, 1, 0);
-- Resultado esperado: ERROR: El producto 4 no está disponible en este momento

--PRUEBA DEL TRIGGER 2 (AL ELIMINAR UN PRODUCTO DE UN PEDIDO)
-- Borramos la línea del latte y confirmamos que el total baja solo.
DELETE FROM detalle_pedido WHERE id_producto = 2 AND id_pedido = 1;
 
SELECT id_pedido, total FROM pedidos WHERE id_pedido = 1;
-- total debe volver a 4.00

--VISTA COMPLETA DEL PEDIDO
SELECT
    p.id_pedido,
    c.nombre || ' ' || c.apellido AS cliente,
    p.estado,
    p.total,
    pr.nombre AS producto,
    d.cantidad,
    d.precio_unitario,
    d.subtotal
FROM pedidos p
JOIN clientes c ON c.id_cliente = p.id_cliente
JOIN detalle_pedido d ON d.id_pedido = p.id_pedido
JOIN productos pr ON pr.id_producto = d.id_producto
WHERE p.id_pedido = 2;


SELECT * FROM pedidos ORDER BY id_pedido DESC LIMIT 1;
SELECT * FROM detalle_pedido WHERE id_pedido = (SELECT MAX(id_pedido) FROM pedidos);

SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';