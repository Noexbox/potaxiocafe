
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

create table detalle_pedido (
id_detalle serial primary key,
id_pedido integer not null,
id_producto integer not null,
cantidad int not null check (cantidad > 0),
precio_unitario
subtotal numeric(8, 2) -- = cantidad * precio calculado por un trigger
);