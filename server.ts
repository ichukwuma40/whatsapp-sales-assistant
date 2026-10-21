import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));

// Initialize Google GenAI
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// 1. WhatsApp Chat Generation Endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const {
      message,
      conversationHistory = [],
      businessContext = {},
      customerInfo = {},
    } = req.body;

    const {
      businessName = 'Shopwise Supermarket',
      industry = 'supermarket',
      businessBio = 'Your reliable neighborhood store with fast WhatsApp delivery',
      currency = '$',
      products = [],
      faqs = [],
      activeOrders = [],
    } = businessContext;

    const catalogSummary = products
      .slice(0, 30)
      .map(
        (p: any) =>
          `[ID: ${p.id}] ${p.name} - ${currency}${p.price} (${p.category}) - ${p.stock > 0 ? 'In Stock (' + p.stock + ')' : 'OUT OF STOCK'}: ${p.description || ''} ${p.tags ? 'Tags: ' + p.tags.join(', ') : ''}`
      )
      .join('\n');

    const faqSummary = faqs
      .slice(0, 20)
      .map((f: any) => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n\n');

    const ordersSummary = activeOrders
      .slice(0, 10)
      .map(
        (o: any) =>
          `Order #${o.orderNumber}: Customer ${o.customerName}, Status: ${o.status}, Total: ${currency}${o.total}, Items: ${o.itemsSummary}, Tracking: ${o.trackingCode || 'N/A'}, Est Delivery: ${o.estimatedDelivery}`
      )
      .join('\n');

    const systemPrompt = `You are "WhatsApp Sales Agent" for "${businessName}" (${industry}).
Tone: Warm, prompt, conversational, proactive sales-oriented, concise (optimized for WhatsApp mobile screen).
Always format messages nicely for WhatsApp: use bold text like *this*, line breaks, bullet points, and appropriate emojis (🛍️, ✅, 📦, ✨, 🚚).

Capabilities:
1. Answer customer questions accurately based ONLY on provided FAQs, Store Policies, and Product Catalog.
2. Recommend the best matching products from the catalog if the customer asks for recommendations, products, prices, or gifts.
3. Check order status if they provide or ask about an order number (e.g. #ORD-XXXX).
4. If customer is ready to buy, guide them to complete checkout or confirm order details.
5. If customer expresses extreme frustration, asks for human manager, or has an issue you cannot resolve, set humanHandoffRequested to true and assure them an agent is joining.
6. Proactively suggest 2-4 short WhatsApp quick-reply buttons (e.g. ["📦 Track Order", "🛒 View Catalog", "💬 Human Support", "⚡ Special Offer"]).

Store Knowledge:
- Industry: ${industry}
- Store Bio: ${businessBio}
- Currency: ${currency}

Products Catalog:
${catalogSummary || 'No products listed currently.'}

Store FAQs & Policies:
${faqSummary || 'Standard 24-48h delivery, card & cash on delivery accepted.'}

Existing Orders Reference:
${ordersSummary || 'No existing orders recorded.'}

Current Customer Info:
Name: ${customerInfo.name || 'Valued Customer'}
Phone: ${customerInfo.phone || 'WhatsApp User'}
Cart items currently: ${customerInfo.cartItems ? JSON.stringify(customerInfo.cartItems) : 'None'}`;

    if (!ai) {
      // Fallback if no Gemini API key configured
      return res.json({
        reply: `Hi ${customerInfo.name || 'there'}! 👋 Welcome to *${businessName}*! How can I assist your order today? You can ask about our catalog, check delivery times, or track your existing order.`,
        recommendedProductIds: products.slice(0, 2).map((p: any) => p.id),
        detectedIntent: 'general_faq',
        suggestedQuickReplies: ['🛒 View Products', '📦 Track Order', '💬 Human Agent'],
        humanHandoffRequested: false,
      });
    }

    const historyFormatted = conversationHistory.slice(-8).map((msg: any) => ({
      role: msg.sender === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text || '' }],
    }));

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        ...historyFormatted,
        {
          role: 'user',
          parts: [{ text: `Customer says: "${message}"` }],
        },
      ],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: {
              type: Type.STRING,
              description: 'The WhatsApp formatted text message to send to the customer.',
            },
            recommendedProductIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'IDs of 1 to 3 products strongly recommended from the catalog, if applicable.',
            },
            detectedIntent: {
              type: Type.STRING,
              description:
                'Intent: product_inquiry | order_tracking | pricing | purchase_intent | abandoned_cart | human_handoff | complaint | general_faq',
            },
            suggestedQuickReplies: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2 to 4 short button labels for quick reply chips (under 25 chars each).',
            },
            extractedOrderNumber: {
              type: Type.STRING,
              description: 'Any order number detected in message or referenced (e.g. ORD-1024), or empty string if none.',
            },
            humanHandoffRequested: {
              type: Type.BOOLEAN,
              description: 'True if customer explicitly asked for a human agent or escalated an issue.',
            },
          },
          required: [
            'reply',
            'recommendedProductIds',
            'detectedIntent',
            'suggestedQuickReplies',
            'humanHandoffRequested',
          ],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return res.json(parsed);
  } catch (error: any) {
    console.error('Gemini chat error:', error);
    return res.status(500).json({
      error: 'Failed to process WhatsApp response',
      details: error.message,
      fallbackReply:
        'Thank you for reaching out! 🙏 We received your message and our sales team is reviewing your inquiry.',
    });
  }
});

// 2. AI Abandoned Cart & Follow-up Generator
app.post('/api/generate-followup', async (req: Request, res: Response) => {
  try {
    const {
      customerName,
      cartItems = [],
      currency = '$',
      totalAmount = 0,
      discountCode = 'SAVE10',
      discountPercent = 10,
      hoursSinceAbandoned = 2,
      businessName = 'Our Store',
      tone = 'friendly_incentive', // 'friendly_incentive' | 'urgency_scarcity' | 'concierge_help'
    } = req.body;

    const itemsList = cartItems
      .map((i: any) => `• ${i.name} (Qty: ${i.quantity || 1}, ${currency}${i.price})`)
      .join('\n');

    if (!ai) {
      return res.json({
        message: `Hi ${customerName}! 👋 We noticed you left some great items in your cart at *${businessName}*:\n\n${itemsList}\n\nUse code *${discountCode}* to get *${discountPercent}% OFF* your order! Click below to complete your checkout before stock runs out:`,
        hook: `Exclusive ${discountPercent}% discount waiting for you`,
      });
    }

    const prompt = `Write a high-converting WhatsApp message to recover an abandoned order.
Customer: ${customerName}
Business: ${businessName}
Hours since abandonment: ${hoursSinceAbandoned} hours
Items in cart:
${itemsList}
Total: ${currency}${totalAmount}
Discount offer: Code ${discountCode} for ${discountPercent}% OFF.
Tone strategy: ${tone} (e.g. friendly discount incentive, gentle concierge assistance, or limited stock alert).

Requirements:
- Must look authentic to WhatsApp: line breaks, bold highlights (*bold*), emojis.
- Never sound spammy; sound like a dedicated store concierge checking in.
- Include a clear call to action (e.g. "Reply YES to confirm order", or "Tap link to pay").
- Return JSON with:
  message: WhatsApp body
  headline: 1-line internal summary
  estimatedConversionRate: percentage string e.g. "34%"`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            message: { type: Type.STRING },
            headline: { type: Type.STRING },
            estimatedConversionRate: { type: Type.STRING },
          },
          required: ['message', 'headline', 'estimatedConversionRate'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return res.json(parsed);
  } catch (error: any) {
    console.error('Follow-up generation error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 3. Lead Qualification & Buying Intent Analyzer
app.post('/api/analyze-lead', async (req: Request, res: Response) => {
  try {
    const { conversation = [], customerName = 'Lead', businessName = 'Store' } = req.body;

    const convoText = conversation
      .map((m: any) => `${m.sender.toUpperCase()}: ${m.text}`)
      .join('\n');

    if (!ai || conversation.length === 0) {
      return res.json({
        buyingIntentScore: 75,
        intentLevel: 'HIGH',
        sentiment: 'Positive',
        keyInterests: ['Product inquiries', 'Pricing'],
        suggestedNextAction: 'Send direct payment link or coupon code to close sale',
        summary: 'Customer has actively engaged with product questions and requested delivery timeline.',
      });
    }

    const prompt = `Analyze this WhatsApp sales conversation for business "${businessName}" with customer "${customerName}":
${convoText}

Provide a CRM analysis:
- buyingIntentScore: number between 0 and 100
- intentLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'READY_TO_BUY'
- sentiment: 'Positive' | 'Neutral' | 'Frustrated' | 'Hesitant'
- keyInterests: string[] (e.g. ["Organic fruits", "Same-day delivery", "Bulk pricing"])
- suggestedNextAction: string (actionable advice for merchant, e.g. "Send 10% coupon", "Offer telephone call", "Confirm delivery address")
- summary: 2-sentence summary of customer needs and status`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            buyingIntentScore: { type: Type.INTEGER },
            intentLevel: { type: Type.STRING },
            sentiment: { type: Type.STRING },
            keyInterests: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestedNextAction: { type: Type.STRING },
            summary: { type: Type.STRING },
          },
          required: [
            'buyingIntentScore',
            'intentLevel',
            'sentiment',
            'keyInterests',
            'suggestedNextAction',
            'summary',
          ],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return res.json(parsed);
  } catch (error: any) {
    console.error('Lead analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 4. WhatsApp Cloud API Webhook Simulation & Test
app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe') {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const payload = req.body;
  console.log('Received WhatsApp Webhook payload:', JSON.stringify(payload, null, 2));
  return res.status(200).json({ status: 'received', timestamp: new Date().toISOString() });
});

// Vite Middleware for Development / Static for Production
async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WhatsSales AI] Server listening on http://0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal server boot error:', err);
});
