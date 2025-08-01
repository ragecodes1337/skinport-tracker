// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';

const app = express();
const port = process.env.PORT || 3000;

// Cache for API responses (5 minutes = 300 seconds, matching the Skinport cache)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

// Skinport API Constants
const SKINPORT_API_URL = 'https://api.skinport.com/v1';
const APP_ID_CSGO = 730;

// Middleware
app.use(cors());
app.use(express.json());

// Function to fetch historical data from Skinport API with caching
async function fetchHistoricalData(marketHashNameSlug, currency) {
    const cacheKey = `historical_${marketHashNameSlug}_${currency}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[API] Cache hit for ${marketHashNameSlug}.`);
        return cachedData;
    }

    try {
        const url = `${SKINPORT_API_URL}/sales/history?app_id=${APP_ID_CSGO}&currency=${currency}&market_hash_name=${encodeURIComponent(marketHashNameSlug)}`;
        
        console.log(`[API] Fetching historical data for: ${marketHashNameSlug}`);
        console.log(`[API] Request URL: ${url}`); // Log the full URL for debugging
        
        const response = await fetch(url, {
            headers: {
                'Accept-Encoding': 'br'
            }
        });

        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();

        if (data.length > 0) {
            // Find the average price from the last week
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

            const recentSales = data.filter(sale => new Date(sale.timestamp) > oneWeekAgo);

            if (recentSales.length > 0) {
                const totalPrices = recentSales.reduce((sum, sale) => sum + sale.price, 0);
                const historicalAvgPrice = totalPrices / recentSales.length;

                const result = { historicalAvgPrice };
                cache.set(cacheKey, result); // Cache the result
                return result;
            }
        }
        
        // No data or no recent sales found
        console.log(`[API] Historical data not found or insufficient for ${marketHashNameSlug}.`);
        return null;

    } catch (error) {
        console.error(`[API] Error fetching historical data for ${marketHashNameSlug}:`, error);
        return null;
    }
}

// Main analysis endpoint
app.post('/scan', async (req, res) => {
    console.log('[Server] Received a new deal scan request.');
    const { items, settings } = req.body;
    console.log(`[Server] Processing ${items.length} items.`);

    const analyzedItems = [];

    // Analyze each item from the request
    for (const item of items) {
        // Fetch real historical data using the Skinport API with the item slug
        const historicalData = await fetchHistoricalData(item.market_hash_name_slug, settings.currency);

        if (historicalData) {
            console.log(`[Server] Historical data found for ${item.market_hash_name}.`);

            // Perform profit calculation based on the real historical data
            const skinportFee = 0.12;
            const netSellingPrice = historicalData.historicalAvgPrice * (1 - skinportFee);
            const potentialProfit = netSellingPrice - item.current_price;
            const profitPercentage = (potentialProfit / item.current_price) * 100;

            // Only add to the list if it meets the profit criteria
            if (potentialProfit >= settings.minProfit && profitPercentage >= settings.minProfitMargin) {
                analyzedItems.push({
                    market_hash_name: item.market_hash_name,
                    market_hash_name_slug: item.market_hash_name_slug,
                    current_price: item.current_price,
                    historicalAvgPrice: historicalData.historicalAvgPrice,
                    netSellingPrice,
                    potentialProfit,
                    profitPercentage
                });
            }
        } else {
            console.log(`[Server] Historical data not found for ${item.market_hash_name}. Skipping this item.`);
        }
    }

    console.log(`[Server] Finished analyzing ${analyzedItems.length} deals.`);
    res.json({ analyzedItems });
});

// A dummy function to simulate a background data collection process
async function runDataCollection() {
    console.log('[Server] Data collection function running...');
    // In a real server, this would be where you would call the API for popular items
    // and store them in a persistent database.
    // For this example, it's a placeholder.
}

// Start Express server
app.listen(port, () => {
    console.log(`[Server] Skinport Tracker running on port ${port}`);
    runDataCollection();
});
