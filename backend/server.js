const express = require('express');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ===================== ENDPOINT: crear un pedido =====================
app.post('/api/pedidos', async (req, res) => {
    const { nombre, apellido, telefono, correo, notas, productos } = req.body;
    // productos = [{ id_producto: 1, cantidad: 2 }, { id_producto: 3, cantidad: 1 }]

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Crear el cliente
        const clienteResult = await client.query(
            `INSERT INTO clientes (nombre, apellido, telefono, correo)
             VALUES ($1, $2, $3, $4) RETURNING id_cliente`,
            [nombre, apellido, telefono, correo]
        );
        const id_cliente = clienteResult.rows[0].id_cliente;

        // 2. Crear el pedido (cabecera vacía, el total lo llenan los triggers)
        const pedidoResult = await client.query(
            `INSERT INTO pedidos (id_cliente, notas)
             VALUES ($1, $2) RETURNING id_pedido`,
            [id_cliente, notas]
        );
        const id_pedido = pedidoResult.rows[0].id_pedido;

        // 3. Insertar cada línea del pedido
        //    (precio_unitario se ignora, el trigger lo reemplaza con el real)
        for (const item of productos) {
            if (item.cantidad > 0) {
                await client.query(
                    `INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario)
                     VALUES ($1, $2, $3, 0)`,
                    [id_pedido, item.id_producto, item.cantidad]
                );
            }
        }

        // 4. Traer el total ya calculado por los triggers
        const totalResult = await client.query(
            'SELECT total FROM pedidos WHERE id_pedido = $1',
            [id_pedido]
        );

        await client.query('COMMIT');

        res.json({
            ok: true,
            id_pedido,
            total: totalResult.rows[0].total
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al crear el pedido:', error.message);
        res.status(400).json({ ok: false, error: error.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});