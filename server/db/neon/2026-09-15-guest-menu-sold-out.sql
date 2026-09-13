-- Neon (surfspirit.sk): položka „dnes vypredaná" — kasa ju sem posiela pri sync menu,
-- PHP ju na webe ukáže ako vypredanú a objednávku s ňou odmietne.
ALTER TABLE guest_menu ADD COLUMN IF NOT EXISTS sold_out_until timestamptz;
