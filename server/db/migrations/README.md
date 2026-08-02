# server/db/migrations

Ručne púšťané SQL migrácie, ktoré **musia byť v gite**.

Projekt inak drží schému cez `drizzle-kit push` (`npm run db:push`) — na kase sa
ale push nespúšťa, DDL sa tam aplikuje ručne cez `docker exec … psql`. Kým tie
skripty žili v `tmp/*.sql`, boli **gitignorované** (`.gitignore` → `/tmp/*.sql`),
takže s commitom vôbec neodišli a na kasu sa nedostali. Výsledok: nasadil sa kód,
ktorý čítal stĺpec, ktorý v produkčnej DB neexistoval.

## Pravidlá

1. Každá zmena schémy, ktorá musí prebehnúť na kase, patrí **sem**, nie do `tmp/`.
2. Názov: `RRRR-MM-DD-kratky-popis.sql`, púšťa sa v poradí podľa dátumu.
3. Skript musí byť **idempotentný** (`IF NOT EXISTS`, `WHERE … IS NULL`, …) —
   pri neistote, či už bežal, sa musí dať pustiť znova.
4. V hlavičke súboru uveď presný príkaz na spustenie na kase a čo sa stane, ak
   sa poradie otočí (kód pred SQL).
5. **Migrácia ide vždy PRED nasadením kódu.** `scripts/deploy-tailscale-pos.sh`
   má bránu, ktorá deploy zastaví, kým migrácia na kase nebežala.

## Spustenie na kase (Docker)

```sh
scp server/db/migrations/<subor>.sql surfs@100.95.64.38:C:/POS/
ssh surfs@100.95.64.38 "docker cp C:\POS\<subor>.sql pos-db-1:/tmp/ && \
  docker exec pos-db-1 psql -U pos -d pos -v ON_ERROR_STOP=1 -f /tmp/<subor>.sql"
```

## Spustenie lokálne (dev docker stack)

```sh
docker cp server/db/migrations/<subor>.sql pos-db-1:/tmp/
docker exec pos-db-1 psql -U pos -d pos -v ON_ERROR_STOP=1 -f /tmp/<subor>.sql
```

Lokálne **testovacie** DB (`pos_test`, `pos_test_w1..w6`) sa udržiavajú cez
`npm run db:push`, nie týmito súbormi.

## Prečo sa migrácia kopíruje cez `scp`, a nie z balíka na kase

`.gitattributes` má `tmp/ export-ignore`, takže staré `tmp/*.sql` sa do deploy
balíka nedostávali vôbec. `server/db/` export-ignore **nemá**, takže po nasadení
tieto súbory na kase sú (`C:\POS\server\db\migrations\`) — lenže to je až PO
nasadení kódu, čiže neskoro. Prvý beh preto vždy `scp` (alebo RDP), na kase
existujúcu kópiu použi len na opakovanie/overenie.
