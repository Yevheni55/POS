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
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this invoice/receipt/delivery note image. Extract all LINE ITEMS that are actual products/ingredients (food, drinks, supplies).

IGNORE these lines completely:
- Tax/VAT/DPH lines
- Shipping/delivery fees
- Discounts/credits
- Subtotals/totals
- Payment method lines
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

Rules:
- "invoiceName": keep exactly as on invoice (e.g. "BBQ Dressing 24x500g")
- "suggestedName": clean short name for a restaurant inventory (e.g. "BBQ Dressing")
- "unit": the unit AS ON THE INVOICE (ks, bal, sud, krt, fl, etc). Keep original.
- "quantity": the count as on the invoice
- "unitCost": price per invoice unit
- "totalCost": total for this line

CRITICAL — Unit conversion for restaurant stock:
- "conversionFactor": how many base units (g, ml, l, kg) are in ONE invoice unit
- "targetUnit": the base unit for stock tracking (must be one of: ks, kg, g, l, ml)
- Examples:
  * "BBQ Dressing 24ks" where each bottle is 500g → quantity:24, unit:"ks", conversionFactor:500, targetUnit:"g"
  * "Pivo sud 50l" → quantity:1, unit:"sud", conversionFactor:50, targetUnit:"l"
  * "Muka 25kg" → quantity:25, unit:"kg", conversionFactor:1, targetUnit:"kg" (no conversion needed)
  * "Coca-Cola 24x0.33l" → quantity:24, unit:"ks", conversionFactor:0.33, targetUnit:"l"
  * "Syrup Monin 0.7l" → quantity:1, unit:"fl", conversionFactor:0.7, targetUnit:"l"
- If the item name contains weight/volume info (e.g. "500g", "0.33l", "50L"), extract it as conversionFactor
- If no conversion is needed (invoice unit = stock unit), set conversionFactor:1 and targetUnit same as unit
- If unit cost is missing, calculate from totalCost / quantity
- If total cost is missing, calculate from unitCost * quantity
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
    const parsed = JSON.parse(jsonStr);

    // Ensure items have both name fields
    if (parsed.items) {
      parsed.items = parsed.items.map(item => ({
        ...item,
        invoiceName: item.invoiceName || item.name || '',
        suggestedName: item.suggestedName || item.name || item.invoiceName || '',
      }));
    }

    res.json(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: err.message });
    }
    res.status(500).json({ error: err.message || 'Invoice scan failed' });
  }
});

export default router;
