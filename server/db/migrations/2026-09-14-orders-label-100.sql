-- orders.label: schema.js hovorí varchar(100), DB mala stále pôvodných 20 znakov.
-- Označenie „ZRUŠENÉ · Wolt W-1234" (zrušené Woltom po prijatí) sa do 20 nezmestí.
ALTER TABLE orders ALTER COLUMN label TYPE varchar(100);
