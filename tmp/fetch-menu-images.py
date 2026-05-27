"""
Stiahne obrázky pre menu položky cez Wikipedia + Wikimedia Commons API,
resize na 400x400 JPEG, uploadne cez POST /api/menu/items/<id>/image.

Wikipedia ma photos pre vsetky standard food/drink items (Mojito, Cappuccino,
Smash burger, Lager beer, Espresso, etc.) — 100% free, CC-BY-SA licencia,
no bot detection.

Pre nestandardne items (combos, brand-specific) mame manualne search hints.
"""
import sys
import os
import io
import time
import base64
import argparse
import sys as _sys
_sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import requests
from PIL import Image, ImageFile
# Tolerovať truncated downloads (Wikimedia občas vracia partial obrázky)
ImageFile.LOAD_TRUNCATED_IMAGES = True

API_BASE = 'http://100.95.64.38:3080'
JWT = open('tmp/jwt.txt').read().strip() if os.path.exists('tmp/jwt.txt') else os.environ.get('JWT', '')

WIKI_API = 'https://en.wikipedia.org/w/api.php'
HDR = {'User-Agent': 'SurfSpirit-POS-MenuImageBot/1.0 (admin@surfspirit.sk)'}

# Custom search queries — pre nase slovak/specificke nazvy mapujeme na
# Wikipedia-friendly english nazov. Pre nestandardne items kompletne
# nakopirujeme zaklad ako "burger" alebo "fries" ktore maju article.
SEARCH_MAP = {
    # Burgers — combos prelozime na zakladnu polozku (kombo = burger + fries)
    'BBQ Smash burger': 'Smashburger',
    'Big Mac Smash burger': 'Hamburger',
    'Chipotle Smash burger': 'Cheeseburger',
    'Combo BBQ Smash': 'Cheeseburger',
    'Combo Big Mac Smash': 'Hamburger',
    'Combo Chipotle Smash': 'Smashburger',
    'Combo Vegetarian Halloumi': 'Halloumi burger',
    'Vegetarian Halloumi burger': 'Halloumi',
    'Omáčka (combo)': 'Dipping sauce',

    # Coffee
    'Espresso / Lungo': 'Espresso',
    'Dvojité espresso (Doppio)': 'Doppio',
    'Cappuccino': 'Cappuccino',
    'Flat White': 'Flat white',
    'Latte / Iced Latte': 'Iced latte',
    'Espresso Tonic 0,25 l': 'Espresso tonic',
    'Čaj sypaný 0,25 l': 'Tea',

    # Drinks (cocktails)
    'Aperol Spritz 0,25 l': 'Aperol Spritz',
    'Cuba Libre 0,25 l': 'Cuba libre',
    'Fiero Tonic 0,25 l': 'Spritz Veneziano',
    'Gin Tonic / Gin Tonic Pink 0,25 l': 'Gin and tonic',
    'Hugo Spritz 0,25 l': 'Hugo (cocktail)',
    'Limoncello Spritz 0,25 l': 'Limoncello',
    'Mojito 0,25 l': 'Mojito',
    'Moscow Mule 0,25 l': 'Moscow mule',
    'Skinny Bitch 0,25 l': 'Vodka soda',

    # Limonády / Smoothies
    'Limonáda Kiwi & Limetka 0,5 l': 'Lemonade',
    'Limonáda Malina & Ruža 0,5 l': 'Raspberry lemonade',
    'Sóda s limetkovou šťavou 0,5 l': 'Limeade',
    'Tropická limonáda 0,5 l': 'Lemonade',
    'Detox': 'Smoothie drink',
    'Green Energy': 'Smoothie drink',
    'Tropický Fresh': 'Smoothie drink',
    'Fanta 0,5 l': 'Fanta',
    'Omáčka kečup 50ml': 'Ketchup bottle',
    'Martell VS': 'Cognac brandy',
    'Combo Vegetarian Halloumi': 'Halloumi',
    'Omáčka chilli-mayo 50ml': 'Mayonnaise jar',
    'Omáčka BBQ 50ml': 'Barbecue sauce bottle',
    'Omáčka (combo)': 'Mayonnaise',
    'Limoncello Spritz 0,25 l': 'Limoncello Spritz',
    'Borovička Spišská 0,04 l': 'Borovička bottle',

    # Šaláty
    'Kurací šalát': 'Chicken salad',
    'Vegetarian Halloumi (šalát)': 'Halloumi',

    # Prílohy
    'Hranolky malé 130g': 'French fries',
    'Hranolky veľké 200g': 'French fries',
    'Kuracie hranolky': 'Chicken strips',
    'Surferské hranolky 200g': 'French fries',
    'Omáčka BBQ 50ml': 'Barbecue sauce',
    'Omáčka Big Mac domáca 50ml': 'Mayonnaise',
    'Omáčka chilli-mayo 50ml': 'Chili mayonnaise',
    'Omáčka kečup 50ml': 'Ketchup',
    'Omáčka tatárka domáca 50ml': 'Tartar sauce',

    # Extra prílohy
    'Slanina, cheddar, chorizo': 'Bacon',
    'Smashed hovädzie s cheddarom': 'Cheeseburger',

    # Pochutiny
    'Chipsy Slovakia': 'Potato chip',
    'Dru tyčinky slané': 'Pretzel',
    'Tyčinky veľké slané': 'Pretzel stick',
    'Nanuky Algida': 'Ice cream bar',

    # Croissanty
    'Croissant Nutella': 'Croissant',
    'Croissant Šunka & Syr': 'Croissant',

    # Beer
    'Urpiner 10° 0,3 l': 'Pilsner',
    'Urpiner 10° 0,5 l': 'Pilsner',
    'Urpiner 12° 0,3 l': 'Pilsner',
    'Urpiner 12° 0,5 l': 'Pilsner',
    'Urpiner Nealko 0,3 l': 'Non-alcoholic beer',
    'Urpiner Nealko 0,5 l': 'Non-alcoholic beer',
    'Urpiner Radler 0,3 l': 'Shandy',
    'Urpiner Radler 0,5 l': 'Shandy',

    # Wine/Sparkling
    'Víno biele 0,1 l': 'White wine',
    'Prosecco 0,1 l': 'Prosecco',
    'Sóda 0,1 l': 'Soda water',

    # Spirits — brand-specific = Wikipedia article exists
    'Becherovka 0,04 l': 'Becherovka',
    'Borovička Spišská 0,04 l': 'Borovička',
    'Slivovica Bošácka 52 0,04 l': 'Slivovitz',
    'Marhuľovica 45 0,04 l': 'Apricot brandy',
    'Hruškovica Jelínek 42 0,04 l': 'Pear brandy',
    'Jägermeister 0,04 l': 'Jägermeister',
    'Fernet Citrus / Stock 0,04 l': 'Fernet',
    'Jack Daniel\'s 0,04 l': 'Jack Daniel\'s',
    'Jameson 0,04 l': 'Jameson Irish Whiskey',
    'Chivas Regal 0,04 l': 'Chivas Regal',
    'Tullamore Dew 0,04 l': 'Tullamore Dew',
    'Martell VS': 'Martell',
    'Gin Beefeater 0,04 l': 'Beefeater Gin',
    'Vodka Finlandia 0,04 l': 'Finlandia (vodka)',
    'Bacardi spiced 0,04l': 'Bacardi',
    'Rum Božkov Republica 0,04 l': 'Božkov Rum',
    'Rum Plantation Grande Reserve 0,04 l': 'Rum',

    # Soft drinks — brand-specific
    'Coca-Cola 0,5 l': 'Coca-Cola',
    'Coca-Cola Zero 0,5 l': 'Coca-Cola Zero Sugar',
    'Sprite 0,5 l': 'Sprite (drink)',
    'Fanta 0,5 l': 'Fanta',
    'Kinley Tonic 0,5 l': 'Tonic water',
    'Kofola 0,3 l': 'Kofola',
    'Kofola 0,5 l': 'Kofola',
    'Ľadový čaj Fuzetea 0,5 l': 'Fuze Tea',
    'Voda minerálna Romerquelle 0,5 l': 'Römerquelle',
    'San Pellegrino 0,33 l': 'Sanpellegrino',
    'Džús 0,2 l': 'Orange juice',
}

# Skip — technické položky čo nepotrebujú obrázok
SKIP_ITEMS = {'Plastovy pohar', 'Záloha fľaša', 'Doblok', 'Platok limetky'}
SKIP_CATEGORIES = {'Čísla'}


def search_wikipedia_image(query):
    """Wikipedia full-text search → ALL article candidates → pageimages.
    Vracia LIST URL-ov pre fallback retry."""
    try:
        r = requests.get(WIKI_API, params={
            'action': 'query', 'format': 'json', 'list': 'search',
            'srsearch': query, 'srlimit': 5,
        }, headers=HDR, timeout=12).json()
        results = r.get('query', {}).get('search', [])
        if not results:
            return []
        urls = []
        for hit in results[:5]:
            title = hit['title']
            r2 = requests.get(WIKI_API, params={
                'action': 'query', 'format': 'json',
                'prop': 'pageimages', 'piprop': 'original|thumbnail',
                'pithumbsize': '600',
                'titles': title,
            }, headers=HDR, timeout=12).json()
            pages = r2.get('query', {}).get('pages', {})
            for pid, page in pages.items():
                if 'original' in page:
                    urls.append(page['original']['source'])
                elif 'thumbnail' in page:
                    urls.append(page['thumbnail']['source'])
        return urls
    except Exception as e:
        print(f'  wiki err: {e}', flush=True)
        return []


def build_query(name, category):
    """Maps Slovak/local name -> English Wikipedia-friendly query."""
    if name in SEARCH_MAP:
        return SEARCH_MAP[name]
    # Default: use the name as-is. Wikipedia search is forgiving.
    return name


def download_and_resize(url, target_size=400, max_bytes=400_000):
    """Stiahne URL, square crop, resize na target_size×target_size, JPEG."""
    try:
        r = requests.get(url, headers=HDR, timeout=20, stream=True)
        r.raise_for_status()
        chunks, total = [], 0
        for chunk in r.iter_content(8192):
            chunks.append(chunk)
            total += len(chunk)
            if total > 8 * 1024 * 1024:
                break
        data = b''.join(chunks)
        img = Image.open(io.BytesIO(data))
        if img.mode in ('RGBA', 'LA', 'P'):
            bg = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            bg.paste(img, mask=img.split()[-1] if 'A' in img.mode else None)
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        w, h = img.size
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        img = img.crop((left, top, left + side, top + side))
        img = img.resize((target_size, target_size), Image.LANCZOS)
        for q in (85, 75, 65, 55):
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=q, optimize=True)
            out = buf.getvalue()
            if len(out) <= max_bytes:
                return out
        return out
    except Exception as e:
        print(f'  download err: {e}', flush=True)
        return None


def upload_image(item_id, jpeg_bytes):
    b64 = base64.b64encode(jpeg_bytes).decode('ascii')
    data_url = 'data:image/jpeg;base64,' + b64
    r = requests.post(
        f'{API_BASE}/api/menu/items/{item_id}/image',
        json={'image': data_url},
        headers={'Authorization': f'Bearer {JWT}', 'Content-Type': 'application/json'},
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f'upload failed {r.status_code}: {r.text[:200]}')
    return r.json()


def fetch_menu_items():
    r = requests.get(f'{API_BASE}/api/menu',
                     headers={'Authorization': f'Bearer {JWT}'}, timeout=15)
    r.raise_for_status()
    cats = r.json()
    items = []
    for cat in cats:
        for it in cat.get('items', []):
            items.append({
                'id': it['id'],
                'name': it['name'],
                'category': cat.get('label', ''),
                'dest': cat.get('dest', 'bar'),
                'imageUrl': it.get('imageUrl') or None,
            })
    return items


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--only', type=int, help='Iba jedna polozka id')
    p.add_argument('--dry', action='store_true', help='Iba vypise queries')
    p.add_argument('--force', action='store_true', help='Prepise aj existujuce')
    p.add_argument('--limit', type=int, default=200)
    args = p.parse_args()

    if not JWT:
        print('!! JWT not set'); sys.exit(1)

    items = fetch_menu_items()
    print(f'Načítaných {len(items)} aktívnych položiek', flush=True)

    if args.only:
        items = [i for i in items if i['id'] == args.only]
    else:
        items = [i for i in items if
                 i['category'] not in SKIP_CATEGORIES and
                 i['name'] not in SKIP_ITEMS and
                 (args.force or not i['imageUrl'])]

    items = items[:args.limit]
    print(f'Spracujem {len(items)} položiek', flush=True)

    ok, fail = 0, 0
    for i, it in enumerate(items, 1):
        q = build_query(it['name'], it['category'])
        print(f'[{i}/{len(items)}] #{it["id"]} {it["name"]:35} → "{q}"', flush=True)
        if args.dry:
            continue
        urls = search_wikipedia_image(q)
        if not urls:
            print('  !! nenajdeny obrazok na Wikipedii', flush=True)
            fail += 1
            time.sleep(0.5)
            continue
        uploaded = False
        for url in urls[:5]:
            data = download_and_resize(url)
            if data is None:
                continue
            try:
                upload_image(it['id'], data)
                print(f'  OK ({len(data)} B)  {url[:90]}', flush=True)
                ok += 1
                uploaded = True
                break
            except Exception as e:
                print(f'  upload err: {e}', flush=True)
        if not uploaded:
            print('  !! ziadny z 5 URL nefunkoval', flush=True)
            fail += 1
        # Wikipedia accepts ~50req/s no problem, mild rate-limit anyway
        time.sleep(0.4)

    print(f'\n=== Hotovo: {ok} OK, {fail} fail ===', flush=True)


if __name__ == '__main__':
    main()
