import { Router } from 'express';
import { db } from '../db/index.js';
import { ingredients } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';

const router = Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * POST /api/invoice-scan
 * Body: { image: "data:image/...;base64,..." }
 */
router.post('/', async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided' });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const allIngredients = await db.select({ id: ingredients.id, name: ingredients.name, unit: ingredients.unit })
      .from(ingredients).where(eq(ingredients.active, true));

    const hasIngredients = allIngredients.length > 0;
    const ingredientList = allIngredients.map(i => `${i.id}:${i.name} (${i.unit})`).join(', ');

    const matchingInstruction = hasIngredients
      ? `\nExisting ingredients in our system (id:name (stock_unit)):\n${ingredientList}\n\nFor each item, try to match to an existing ingredient by name similarity. If matched:\n- add "matchedIngredientId": <id>\n- set "targetUnit" to match that ingredient's stock unit\n- calculate "conversionFactor" accordingly (e.g. if ingredient tracks in "g" and invoice says "24 ks" of 500g bottles, conversionFactor=500)\nIf no match, omit matchedIngredientId but still estimate conversionFactor from the product name.`
      : '\nNo existing ingredients in the system yet. Do not add matchedIngredientId to any item. Still estimate conversionFactor from product names.';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4000,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this invoice/receipt/delivery note image. Extract EVERY LINE ITEM that is an actual product/ingredient (food, drinks, supplies).

IGNORE these lines completely:
- Tax/VAT/DPH lines
- Shipping/delivery fees (doprava, preprava)
- Discounts/credits (zľava, kredit)
- Subtotals/totals (spolu, celkom, medzisúčet)
- Payment method lines
- Vratné obaly / deposit / záloha on reusable containers (these are not separate products)
- Any non-product line

Return ONLY valid JSON (no markdown, no backticks, no explanation):
{
  "supplier": "supplier company name or null",
  "invoiceNumber": "invoice/receipt number or null",
  "date": "YYYY-MM-DD or null",
  "items": [
    {
      "invoiceName": "exact name as written on invoice",
      "suggestedName": "clean short ingredient name for our system",
      "category": "ingredient",
      "quantity": 5.0,
      "unit": "ks",
      "unitCost": 3.50,
      "totalCost": 17.50,
      "conversionFactor": 500,
      "targetUnit": "g"
    }
  ]
}

CRITICAL — Categorize each item:
- "category": "ingredient" — food, drinks, spices, sauces, raw materials that go INTO dishes/drinks
- "category": "supply" — cleaning products, hygiene, paper towels, napkins, bags, packaging, chemicals, toilet paper, soap, detergent, gloves, foil, trash bags — anything NOT edible

CRITICAL — Quantity rules (this is the most common OCR error, read carefully):
- "quantity" is the number in the MNOŽSTVO / POČET / KS / QTY / Quantity column for that row — ONLY that column.
- DO NOT use numbers that appear inside the product name (like "50L", "24x", "500g", "13°") as quantity.
- DO NOT merge, sum, or deduplicate identical product names — each printed row is ONE item; if the same product appears twice, output it twice.
- If a row has sub-lines / pack breakdown (e.g. "13 × sud 50 L"), quantity is 13, unit is "sud", conversionFactor is 50, targetUnit is "l".
- Trust the column order of the invoice, not the product description.
- If OCR is uncertain, prefer the larger plausible integer from the quantity column over a smaller number from the name.

Rules:
- "invoiceName": keep exactly as on invoice (e.g. "BBQ Dressing 24x500g")
- "suggestedName": clean short name for a restaurant inventory (e.g. "BBQ Dressing")
- "unit": the unit AS ON THE INVOICE (ks, bal, sud, krt, fl, etc). Keep original.
- "unitCost": price per invoice unit
- "totalCost": total for this line

CRITICAL — Unit conversion for restaurant stock:
- "conversionFactor": how many base units (g, ml, l, kg) are in ONE invoice unit
- "targetUnit": the base unit for stock tracking (must be one of: ks, kg, g, l, ml)
- Examples:
  * "BBQ Dressing 24ks" where each bottle is 500g → quantity:24, unit:"ks", conversionFactor:500, targetUnit:"g"
  * "Pivo sud 50l" with "13" in množstvo column → quantity:13, unit:"sud", conversionFactor:50, targetUnit:"l"
  * "Muka 25kg" with "4" in množstvo column → quantity:4, unit:"vrece", conversionFactor:25, targetUnit:"kg"
  * "Coca-Cola 24x0.33l" with "2" in množstvo column → quantity:2, unit:"krt", conversionFactor:24*0.33 = 7.92, targetUnit:"l"
  * "Syrup Monin 0.7l" with "3" in množstvo column → quantity:3, unit:"fl", conversionFactor:0.7, targetUnit:"l"
- If the item name contains weight/volume info (e.g. "500g", "0.33l", "50L"), that goes into conversionFactor — NEVER into quantity.
- If no conversion is needed (invoice unit = stock unit), set conversionFactor:1 and targetUnit same as unit
- If unit cost is missing, calculate from totalCost / quantity
- If total cost is missing, calculate from unitCost * quantity
- After composing the items list, mentally verify: sum of (quantity * unitCost) should be close to the invoice total (without VAT / shipping). If not, re-read the quantity column.
${matchingInstruction}`
          },
          {
            type: 'image_url',
            image_url: { url: image, detail: 'high' }
          }
        ]
      }]
    });

    const text = response.choices[0]?.message?.content || '';
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[invoice-scan] LLM response parse failed', { staffId: req.user?.id, preview: String(text).slice(0, 500) });
      return res.status(500).json({ error: 'Parse failed' });
    }

    // Ensure items have both name fields
    if (Array.isArray(parsed.items)) {
      parsed.items = parsed.items.map((item) => ({
        ...item,
        invoiceName: item.invoiceName || item.name || '',
        suggestedName: item.suggestedName || item.name || item.invoiceName || '',
      }));
    } else {
      parsed.items = [];
    }

    // Diagnostika: log aj na backend, keby AI vynechal riadky — manager vidí v `docker logs`
    console.log(
      `[invoice-scan] supplier="${parsed.supplier || ''}" items=${parsed.items.length} ` +
      `total=${parsed.items.reduce((s, i) => s + Number(i.totalCost || 0), 0).toFixed(2)} ` +
      `invoice=${parsed.invoiceNumber || '-'}`,
    );

    res.json(parsed);
  } catch (err) {
    console.error('[invoice-scan] request failed', { staffId: req.user?.id, err: err.stack || String(err) });
    res.status(500).json({ error: 'Invoice scan failed' });
  }
});

export default router;
