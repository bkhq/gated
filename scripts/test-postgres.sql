-- Test fixture for a PostgreSQL target.
-- Creates a `testdb` database with a few related tables and sample rows so the
-- SQL console / DB terminal have something to browse and query.
--
-- Usage (connect to the `postgres` maintenance DB, it switches with \connect):
--   psql -h <host> -p <port> -U <user> -f scripts/test-postgres.sql
-- e.g. against a local server:
--   psql -h 127.0.0.1 -p 5432 -U postgres -f scripts/test-postgres.sql

-- Recreate from scratch so the script is re-runnable.
DROP DATABASE IF EXISTS testdb;
CREATE DATABASE testdb;

\connect testdb

CREATE TABLE customers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    email      VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id       SERIAL PRIMARY KEY,
    title    VARCHAR(120) NOT NULL,
    price    NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    in_stock BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE orders (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    ordered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    total       NUMERIC(10, 2) NOT NULL DEFAULT 0
);

CREATE TABLE order_items (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products (id),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10, 2) NOT NULL
);

CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_order_items_order ON order_items (order_id);

INSERT INTO customers (name, email) VALUES
    ('Alice Chen', 'alice@example.com'),
    ('Bob Lee', 'bob@example.com'),
    ('Carol Wang', 'carol@example.com');

INSERT INTO products (title, price, in_stock) VALUES
    ('Widget', 9.99, true),
    ('Gadget', 19.95, true),
    ('Gizmo', 4.50, false);

INSERT INTO orders (customer_id, status, total) VALUES
    (1, 'paid', 39.93),
    (2, 'pending', 19.95),
    (1, 'shipped', 13.50);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 2, 9.99),
    (1, 2, 1, 19.95),
    (2, 2, 1, 19.95),
    (3, 3, 3, 4.50);

-- A view to exercise non-table objects too.
CREATE VIEW order_summary AS
SELECT
    o.id            AS order_id,
    c.name          AS customer,
    o.status,
    o.total,
    count(oi.id)    AS line_items
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, c.name, o.status, o.total
ORDER BY o.id;

-- Quick sanity output when run interactively.
SELECT 'customers' AS table, count(*) FROM customers
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items;
