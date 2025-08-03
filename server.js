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
const SKINPORT_FEE = 0.08; // 8% seller fee
const MINIMUM_PROFIT_THRESHOLD = 0.12; // Minimum €0.12 profit (optimized for capturing more small opportunities)

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 7; // Use 7 to be safe (was 5, now closer to the 8 limit)
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Normalize item names for consistent matching between server and content script
 */
function normalizeItemName(name) {
    if (!name) return null;
    
    return name.trim()
        // Normalize StatTrak symbol
        .replace(/StatTrak™?/g, 'StatTrak™')
        // Normalize knife star symbol
        .replace(/★/g, '★')
        // Normalize spaces
        .replace(/\s+/g, ' ')
        // Remove any trailing/leading spaces
        .trim();
}

/**
 * Float Value Intelligence - Parse and categorize float values for enhanced pricing
 */
function analyzeFloatValue(itemName, currentPrice) {
    // Extract float value from item name (if present)
    const floatMatch = itemName.match(/(\d+\.\d+)/);
    const hasFloat = floatMatch !== null;
    const floatValue = hasFloat ? parseFloat(floatMatch[1]) : null;
    
    if (!hasFloat || floatValue === null) {
        return {
            hasFloat: false,
            floatValue: null,
            floatTier: 'UNKNOWN',
            floatMultiplier: 1.0,
            floatAnalysis: 'No float value detected in item name'
        };
    }
    
    // Determine wear condition from item name
    let wearCondition = 'UNKNOWN';
    let baseFloatRanges = {};
    
    if (itemName.includes('Factory New')) {
        wearCondition = 'FN';
        baseFloatRanges = { min: 0.00, max: 0.07, optimal: 0.00, premium: 0.01 };
    } else if (itemName.includes('Minimal Wear')) {
        wearCondition = 'MW';
        baseFloatRanges = { min: 0.07, max: 0.15, optimal: 0.07, premium: 0.08 };
    } else if (itemName.includes('Field-Tested')) {
        wearCondition = 'FT';
        baseFloatRanges = { min: 0.15, max: 0.38, optimal: 0.15, premium: 0.20 };
    } else if (itemName.includes('Well-Worn')) {
        wearCondition = 'WW';
        baseFloatRanges = { min: 0.38, max: 0.45, optimal: 0.38, premium: 0.40 };
    } else if (itemName.includes('Battle-Scarred')) {
        wearCondition = 'BS';
        baseFloatRanges = { min: 0.45, max: 1.00, optimal: 0.45, premium: 0.50 };
    }
    
    if (wearCondition === 'UNKNOWN') {
        return {
            hasFloat: true,
            floatValue: floatValue,
            floatTier: 'UNKNOWN_WEAR',
            floatMultiplier: 1.0,
            floatAnalysis: `Float ${floatValue} detected but wear condition unknown`
        };
    }
    
    // Calculate float percentile within wear range
    const range = baseFloatRanges.max - baseFloatRanges.min;
    const floatPosition = (floatValue - baseFloatRanges.min) / range;
    
    // Determine float tier and pricing multiplier
    let floatTier, floatMultiplier, floatAnalysis;
    
    if (floatValue <= baseFloatRanges.premium) {
        // Premium float (top 10-20% of wear range)
        floatTier = 'PREMIUM';
        floatMultiplier = wearCondition === 'FN' ? 1.15 : 
                         wearCondition === 'MW' ? 1.12 : 
                         wearCondition === 'FT' ? 1.08 : 1.05;
        floatAnalysis = `Premium ${wearCondition} float (${floatValue}) - expect ${((floatMultiplier - 1) * 100).toFixed(0)}% price premium`;
    } else if (floatPosition <= 0.3) {
        // Good float (bottom 30% of wear range)
        floatTier = 'GOOD';
        floatMultiplier = wearCondition === 'FN' ? 1.08 : 
                         wearCondition === 'MW' ? 1.06 : 
                         wearCondition === 'FT' ? 1.04 : 1.02;
        floatAnalysis = `Good ${wearCondition} float (${floatValue}) - expect ${((floatMultiplier - 1) * 100).toFixed(0)}% price bonus`;
    } else if (floatPosition <= 0.7) {
        // Average float (middle 40% of wear range)
        floatTier = 'AVERAGE';
        floatMultiplier = 1.0;
        floatAnalysis = `Average ${wearCondition} float (${floatValue}) - standard pricing`;
    } else {
        // Poor float (top 30% of wear range)
        floatTier = 'POOR';
        floatMultiplier = wearCondition === 'FN' ? 0.92 : 
                         wearCondition === 'MW' ? 0.94 : 
                         wearCondition === 'FT' ? 0.96 : 0.98;
        floatAnalysis = `Poor ${wearCondition} float (${floatValue}) - expect ${((1 - floatMultiplier) * 100).toFixed(0)}% price discount`;
    }
    
    return {
        hasFloat: true,
        floatValue: floatValue,
        wearCondition: wearCondition,
        floatTier: floatTier,
        floatMultiplier: floatMultiplier,
        floatPosition: floatPosition,
        floatAnalysis: floatAnalysis,
        floatRanges: baseFloatRanges
    };
}

/**
 * Multi-timeframe analysis with RECENT-FIRST priority for accurate market pricing
 */
function analyzeMultiTimeframe(salesData) {
    const timeframes = [];
    
    // Check all available timeframes
    if (salesData.last_24_hours && salesData.last_24_hours.volume > 0) {
        timeframes.push({
            period: '24h',
            data: salesData.last_24_hours,
            weight: 10, // MUCH higher weight for recent data
            recency: 1,
            priorityTier: 1 // Highest priority
        });
    }
    
    if (salesData.last_7_days && salesData.last_7_days.volume > 0) {
        timeframes.push({
            period: '7d',
            data: salesData.last_7_days,
            weight: 8, // High weight for weekly data
            recency: 2,
            priorityTier: 1 // Highest priority
        });
    }
    
    if (salesData.last_30_days && salesData.last_30_days.volume > 0) {
        timeframes.push({
            period: '30d',
            data: salesData.last_30_days,
            weight: 4, // Lower weight for monthly
            recency: 3,
            priorityTier: 2 // Medium priority - fallback only
        });
    }
    
    if (salesData.last_90_days && salesData.last_90_days.volume > 0) {
        timeframes.push({
            period: '90d',
            data: salesData.last_90_days,
            weight: 1, // Very low weight for quarterly
            recency: 4,
            priorityTier: 3 // Low priority - trend analysis only
        });
    }
    
    if (timeframes.length === 0) {
        return null;
    }
    
    // REALISTIC TIMEFRAME Selection Logic - Focus on 7d data for better market reality:
    // 1. Prefer 7d data if volume >= 1 (realistic weekly pattern)
    // 2. Use 24h if volume >= 3 AND no 7d data (strong daily activity)
    // 3. Use 30d if volume >= 5 (monthly sample as fallback)
    // 4. Use 90d as last resort if volume >= 8 (quarterly trend)
    
    let bestTimeframe;
    
    // PRIORITY: 7d data with ANY meaningful activity (realistic approach)
    const tf7d = timeframes.find(t => t.period === '7d');
    if (tf7d && tf7d.data.volume >= 1) {
        bestTimeframe = tf7d;
        console.log(`[Timeframe Selection] Using 7d data: ${tf7d.data.volume} sales, €${tf7d.data.avg.toFixed(2)} avg - WEEKLY REALITY`);
    }
    // Second choice: 24h with decent volume (only if no 7d data)
    else {
        const tf24h = timeframes.find(t => t.period === '24h');
        if (tf24h && tf24h.data.volume >= 3) {
            bestTimeframe = tf24h;
            console.log(`[Timeframe Selection] Using 24h data: ${tf24h.data.volume} sales, €${tf24h.data.avg.toFixed(2)} avg - DAILY ACTIVITY`);
        }
        // Third choice: 30d with some volume
        else {
            const tf30d = timeframes.find(t => t.period === '30d');
            if (tf30d && tf30d.data.volume >= 5) {
                bestTimeframe = tf30d;
                console.log(`[Timeframe Selection] Using 30d data: ${tf30d.data.volume} sales, €${tf30d.data.avg.toFixed(2)} avg - MONTHLY SAMPLE`);
            }
            // Fourth choice: 90d with reasonable volume
            else {
                const tf90d = timeframes.find(t => t.period === '90d');
                if (tf90d && tf90d.data.volume >= 8) {
                    bestTimeframe = tf90d;
                    console.log(`[Timeframe Selection] Using 90d data: ${tf90d.data.volume} sales, €${tf90d.data.avg.toFixed(2)} avg - QUARTERLY TREND`);
                }
                // Last resort: Best available with WARNING
                else {
                    bestTimeframe = timeframes.reduce((best, current) => {
                        return current.data.volume > best.data.volume ? current : best;
                    });
                    console.log(`[TIMEFRAME WARNING] Using ${bestTimeframe.period} data with LOW VOLUME: ${bestTimeframe.data.volume} sales - PROCEED WITH CAUTION`);
                }
            }
        }
    }
    
    // REALISTIC: Accept items with minimal market data (1+ sales)
    if (!bestTimeframe || bestTimeframe.data.volume < 1) {
        console.log(`[INSUFFICIENT DATA REJECTION] Item has ${bestTimeframe?.data.volume || 0} sales in best timeframe - NO MARKET DATA`);
        return null; // Signal to calling function that this item should be skipped
    }
    
    // Detect price trend using recent vs older data
    let trend = 'STABLE';
    const recent24h = timeframes.find(t => t.period === '24h');
    const recent7d = timeframes.find(t => t.period === '7d');
    const older30d = timeframes.find(t => t.period === '30d');
    
    if (recent24h && recent7d) {
        const priceChange = ((recent24h.data.avg - recent7d.data.avg) / recent7d.data.avg) * 100;
        if (priceChange > 8) trend = 'RISING';
        else if (priceChange < -8) trend = 'FALLING';
    } else if (recent7d && older30d) {
        const priceChange = ((recent7d.data.avg - older30d.data.avg) / older30d.data.avg) * 100;
        if (priceChange > 10) trend = 'RISING';
        else if (priceChange < -10) trend = 'FALLING';
    }
    
    // CRITICAL: Early volatility check using selected timeframe data
    const timeframeSalesData = bestTimeframe.data;
    const timeframeVolatility = ((timeframeSalesData.max - timeframeSalesData.min) / timeframeSalesData.avg) * 100;
    
    if (timeframeVolatility > 200) {
        console.log(`[EARLY VOLATILITY REJECTION] ${timeframeVolatility.toFixed(1)}% volatility in ${bestTimeframe.period} timeframe - MARKET CHAOS, REJECTED`);
        return null; // Immediately reject extreme volatility items
    }
    
    return {
        bestTimeframe,
        allTimeframes: timeframes,
        trend,
        confidence: timeframes.length >= 2 ? 'HIGH' : timeframes.length === 1 ? 'MEDIUM' : 'LOW',
        recentDataQuality: recent24h ? 'EXCELLENT' : recent7d ? 'GOOD' : 'LIMITED'
    };
}

/**
 * PROFITABILITY-FIRST Smart pricing calculation - ensures profit before market positioning
 */
function calculateSmartAchievablePrice(buyPrice, marketData, multiTimeframeData, currentMinPrice, floatAnalysis = null) {
    if (!multiTimeframeData || !multiTimeframeData.bestTimeframe) {
        // Fallback to simple competitive pricing
        return {
            achievablePrice: currentMinPrice * 0.95,
            confidence: 'LOW',
            strategy: 'FALLBACK_COMPETITIVE',
            reasoning: 'Limited sales data, using competitive pricing'
        };
    }
    
    const salesData = multiTimeframeData.bestTimeframe.data;
    const trend = multiTimeframeData.trend;
    
    // Calculate various price points from sales data
    const salesMedian = salesData.median || salesData.avg;
    const salesAvg = salesData.avg;
    const salesMin = salesData.min;
    const salesMax = salesData.max;
    const salesVolume = salesData.volume;
    
    // CRITICAL: Check against RECENT sales averages (24h/7d priority)
    const recentDataQuality = multiTimeframeData.recentDataQuality;
    const bestPeriod = multiTimeframeData.bestTimeframe.period;
    
    // Get most recent average for reality check - ENHANCED LOGIC
    const recent24hAvg = multiTimeframeData.allTimeframes.find(t => t.period === '24h')?.data.avg;
    const recent7dAvg = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.avg;
    
    // STEP 1: PROFITABILITY-FIRST ANALYSIS - Calculate what we NEED to make profit
    // FIX: Use ACTUAL 7d volume, fallback to reasonable estimate based on SELECTED timeframe
    const actual7dVolume = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.volume || 0;
    let weeklyVolume;
    
    if (actual7dVolume > 0) {
        weeklyVolume = actual7dVolume;
    } else if (bestPeriod === '24h') {
        // Conservative estimate: don't extrapolate 24h to weekly (too unreliable)
        weeklyVolume = Math.min(salesVolume * 2, salesVolume + 3); // Conservative daily to weekly estimate
    } else if (bestPeriod === '30d') {
        weeklyVolume = Math.max(salesVolume / 4, 1); // Monthly to weekly estimate
    } else if (bestPeriod === '90d') {
        weeklyVolume = Math.max(salesVolume / 12, 1); // Quarterly to weekly estimate
    } else {
        weeklyVolume = Math.max(salesVolume / 4, 1); // Default fallback
    }
    
    console.log(`[Weekly Volume Fix] ${bestPeriod} period with ${salesVolume} sales → estimated weekly: ${weeklyVolume} (actual 7d: ${actual7dVolume})`);
    
    // Market stability analysis using SALES DATA volatility (not current listings spread)
    const currentMinPrice_val = marketData.min_price;
    const currentMaxPrice = marketData.max_price;
    const currentMeanPrice = marketData.mean_price;
    
    // CRITICAL FIX: Use sales data volatility for decision making, not current listing spread
    const salesVolatility = ((salesMax - salesMin) / salesAvg) * 100;
    const currentListingSpread = ((currentMaxPrice - currentMinPrice_val) / currentMeanPrice) * 100;
    
    // EARLY VOLATILITY REJECTION: Catch extreme cases immediately 
    if (salesVolatility > 200) {
        console.log(`[EARLY VOLATILITY REJECTION] ${salesVolatility.toFixed(1)}% volatility - TOO EXTREME FOR ANALYSIS`);
        return null; // Signal immediate rejection to calling function
    }
    
    // STABLE ITEM DETECTION: Use SALES volatility (not current listings) + decent volume
    const isStableItem = salesVolatility <= 15 && weeklyVolume >= 3; // Low sales volatility + decent volume
    const isHighVelocity = weeklyVolume >= 8; // Fast-moving items
    
    let minProfitMargin;
    let velocityCategory;
    let stabilityBonus = '';
    
    // REALISTIC MARGIN SYSTEM: Practical CS:GO trading margins for actual profitability
    if (isStableItem && isHighVelocity) {
        // STABLE + HIGH VELOCITY: Premium category - lower margins but reliable
        velocityCategory = 'STABLE_HIGH_VELOCITY';
        if (buyPrice < 20) {
            minProfitMargin = 0.03; // 3% for small stable items - realistic
        } else if (buyPrice < 100) {
            minProfitMargin = 0.04; // 4% for medium stable items - realistic
        } else {
            minProfitMargin = 0.05; // 5% for expensive stable items - realistic
        }
        stabilityBonus = ' [STABLE+FAST]';
    } else if (isStableItem) {
        // STABLE MEDIUM VELOCITY: Good for reliable flips
        velocityCategory = 'STABLE_MEDIUM_VELOCITY';
        if (buyPrice < 30) {
            minProfitMargin = 0.035; // 3.5% for small stable items
        } else if (buyPrice < 150) {
            minProfitMargin = 0.045; // 4.5% for medium stable items
        } else {
            minProfitMargin = 0.04; // 4% for expensive stable items
        }
        stabilityBonus = ' [STABLE]';
    } else if (weeklyVolume >= 5) {
        // HIGH VELOCITY but potentially volatile - relaxed threshold from 8 to 5
        velocityCategory = 'HIGH_VELOCITY';
        if (buyPrice < 15) {
            minProfitMargin = 0.025; // 2.5% for small, fast-moving items
        } else if (buyPrice < 80) {
            minProfitMargin = 0.03; // 3% for medium, fast-moving items
        } else {
            minProfitMargin = 0.035; // 3.5% for expensive, fast-moving items
        }
    } else if (weeklyVolume >= 1) {
        // REALISTIC VELOCITY - accepting 1+ sales/week as viable
        velocityCategory = 'REALISTIC_VELOCITY';
        if (buyPrice < 25) {
            minProfitMargin = 0.04; // 4% for small items with some activity
        } else if (buyPrice < 120) {
            minProfitMargin = 0.05; // 5% for medium items with some activity
        } else {
            minProfitMargin = 0.045; // 4.5% for expensive items with some activity
        }
    } else {
        // VERY LOW VELOCITY - still worth trying with higher margins
        velocityCategory = 'LOW_VELOCITY_SPECULATIVE';
        if (buyPrice < 20) {
            minProfitMargin = 0.06; // 6% for small, slow-moving items
        } else if (buyPrice < 100) {
            minProfitMargin = 0.07; // 7% for medium, slow-moving items
        } else {
            minProfitMargin = 0.065; // 6.5% for expensive, slow-moving items
        }
    }
    
    // Calculate MINIMUM profitable price (what we MUST get to make profit)
    const minProfitablePrice = buyPrice * (1 + minProfitMargin) / (1 - SKINPORT_FEE);
    
    console.log(`[Profitability-First] ${buyPrice.toFixed(2)} item: Need €${minProfitablePrice.toFixed(2)} minimum (${(minProfitMargin*100).toFixed(1)}% margin) [${velocityCategory}: ${weeklyVolume} sales/week, ${salesVolatility.toFixed(1)}% sales volatility]${stabilityBonus}`);
    
    // STEP 2: MARKET REALITY CHECK - Can the market support our minimum price?
    // ENHANCED SELECTION: Use more conservative recent averages, avoid outlier influence
    let recentMarketAvg;
    let selectedPeriod;
    
    if (recent24hAvg && recent7dAvg) {
        // CRITICAL FIX: If 24h avg is significantly different from 7d avg, prefer 7d for stability
        const priceDeviation = Math.abs(recent24hAvg - recent7dAvg) / recent7dAvg;
        
        if (priceDeviation > 0.15) { // 15% deviation threshold
            // Significant difference - use 7d for stability
            recentMarketAvg = recent7dAvg;
            selectedPeriod = '7d';
            console.log(`[Conservative Price Selection] Using 7d avg (€${recent7dAvg.toFixed(2)}) - 24h avg (€${recent24hAvg.toFixed(2)}) shows ${(priceDeviation * 100).toFixed(1)}% deviation`);
        } else if (recent24hAvg > recent7dAvg * 1.05) {
            // 24h slightly above 7d - still prefer 7d for conservatism
            recentMarketAvg = recent7dAvg;
            selectedPeriod = '7d';
            console.log(`[Conservative Selection] Using 7d avg (€${recent7dAvg.toFixed(2)}) over 24h avg (€${recent24hAvg.toFixed(2)}) for conservative pricing`);
        } else {
            // Similar prices - can use 24h
            recentMarketAvg = recent24hAvg;
            selectedPeriod = '24h';
        }
    } else {
        recentMarketAvg = recent24hAvg || recent7dAvg || salesAvg;
        selectedPeriod = recent24hAvg ? '24h' : recent7dAvg ? '7d' : bestPeriod;
    }
    
    // ADDITIONAL REALITY CHECK: For high volatility items, use lower percentile instead of average
    if (salesVolatility > 100) {
        // Use 60th percentile instead of average for high volatility items
        const conservativePrice = salesMin + ((salesMax - salesMin) * 0.6);
        if (conservativePrice < recentMarketAvg) {
            console.log(`[High Volatility Adjustment] Using 60th percentile (€${conservativePrice.toFixed(2)}) instead of avg (€${recentMarketAvg.toFixed(2)}) for ${salesVolatility.toFixed(1)}% volatility item`);
            recentMarketAvg = conservativePrice;
            selectedPeriod += '_60P'; // Mark as percentile-adjusted
        }
    }
    
    // REALISTIC VOLATILITY-BASED MARKET TOLERANCE: Accept real-world CS:GO market conditions
    // (salesVolatility already calculated above)
    let marketToleranceMultiplier;
    let volatilityCategory;
    
    if (salesVolatility > 200) {
        // EXTREME VOLATILITY (200%+): Auto-reject - market too chaotic for reliable trading
        console.log(`[EXTREME VOLATILITY REJECTION] ${salesVolatility.toFixed(1)}% volatility exceeds 200% limit - MARKET CHAOS`);
        return {
            achievablePrice: 0,
            confidence: 'REJECTED',
            strategy: 'EXTREME_VOLATILITY',
            reasoning: `REJECTED: Extreme volatility (${salesVolatility.toFixed(1)}%) indicates market manipulation or pricing chaos - unsafe for trading`
        };
    } else if (salesVolatility > 150) {
        // VERY HIGH VOLATILITY (150-200%): Nearly auto-reject with ultra-conservative pricing
        console.log(`[VERY HIGH VOLATILITY WARNING] ${salesVolatility.toFixed(1)}% volatility - ULTRA CONSERVATIVE mode only`);
        marketToleranceMultiplier = Math.max(0.90, Math.min(0.98, (salesMin * 0.98) / recentMarketAvg)); // Max 98% of recent avg, strongly prefer minimum
        volatilityCategory = 'VERY_HIGH_VOLATILITY_ULTRA_CONSERVATIVE';
    } else if (salesVolatility > 120) {
        // HIGH VOLATILITY (120-200%): Much more conservative pricing - MAJOR FIX
        marketToleranceMultiplier = Math.max(0.95, Math.min(1.02, (salesMin * 1.02) / recentMarketAvg)); // Max 102% of recent avg, prefer near minimum
        volatilityCategory = 'HIGH_VOLATILITY_VERY_CONSERVATIVE';
        console.log(`[HIGH VOLATILITY CONSERVATIVE] ${salesVolatility.toFixed(1)}% volatility - using very conservative pricing (near sales minimum)`);
    } else if (salesVolatility > 60) {
        // MODERATE-HIGH VOLATILITY (60-120%): Much more conservative - ENHANCED FOR REALISM
        marketToleranceMultiplier = 1.00; // 100% of recent average - NO PREMIUM for volatility
        volatilityCategory = 'MODERATE_HIGH_VOLATILITY_CONSERVATIVE';
        console.log(`[MODERATE-HIGH VOLATILITY] ${salesVolatility.toFixed(1)}% volatility - NO PREMIUM pricing, recent average max`);
    } else if (salesVolatility > 40) {
        // MODERATE VOLATILITY (40-60%): Slightly conservative CS:GO pricing
        marketToleranceMultiplier = 1.03; // 103% of recent average (was 108%)
        volatilityCategory = 'MODERATE_VOLATILITY';
        console.log(`[MODERATE VOLATILITY] ${salesVolatility.toFixed(1)}% volatility - slightly conservative CS:GO pricing`);
    } else if (salesVolatility > 20) {
        // LOW VOLATILITY (20-40%): Good market conditions
        marketToleranceMultiplier = 1.06; // 106% of recent average (was 112%)
        volatilityCategory = 'LOW_VOLATILITY';
    } else {
        // VERY LOW VOLATILITY (≤20%): Stable market - modest premium allowed
        marketToleranceMultiplier = 1.08; // 108% of recent average (was 115%)
        volatilityCategory = 'VERY_LOW_VOLATILITY';
    }
    
    const marketTolerance = recentMarketAvg * marketToleranceMultiplier;
    
    console.log(`[Volatility Analysis] ${salesVolatility.toFixed(1)}% volatility (${volatilityCategory}) - tolerance: ${(marketToleranceMultiplier * 100).toFixed(1)}% of recent avg`);
    
    // CRITICAL CHECK: If our minimum profitable price exceeds market reality, REJECT immediately
    if (minProfitablePrice > marketTolerance) {
        console.log(`[PROFITABILITY REJECTION] Minimum profit €${minProfitablePrice.toFixed(2)} exceeds market tolerance €${marketTolerance.toFixed(2)} (${(marketToleranceMultiplier * 100).toFixed(1)}% of €${recentMarketAvg.toFixed(2)} ${selectedPeriod} avg) - IMPOSSIBLE PROFIT`);
        return {
            achievablePrice: 0, // Signal rejection
            confidence: 'REJECTED',
            strategy: 'PROFIT_IMPOSSIBLE',
            reasoning: `Minimum ${(minProfitMargin*100).toFixed(1)}% margin (€${minProfitablePrice.toFixed(2)}) exceeds ${volatilityCategory.toLowerCase()} market tolerance (€${marketTolerance.toFixed(2)} max)`
        };
    }
    
    // ADDITIONAL REALITY CHECK: Buying too close to market average is risky
    const buyVsMarketRatio = buyPrice / recentMarketAvg;
    if (buyVsMarketRatio > 0.95) { // Buying at 95%+ of market average
        console.log(`[HIGH RISK WARNING] Buying at €${buyPrice.toFixed(2)} vs market avg €${recentMarketAvg.toFixed(2)} (${(buyVsMarketRatio * 100).toFixed(1)}%) - limited upside potential`);
        
        // For high-volatility items close to market average, be extra conservative
        if (salesVolatility > 80 && buyVsMarketRatio > 0.92) {
            console.log(`[RISKY TRADE REJECTION] High volatility (${salesVolatility.toFixed(1)}%) + high buy ratio (${(buyVsMarketRatio * 100).toFixed(1)}%) = too risky`);
            return {
                achievablePrice: 0,
                confidence: 'REJECTED',
                strategy: 'HIGH_RISK_TRADE',
                reasoning: `Buying at ${(buyVsMarketRatio * 100).toFixed(1)}% of market average with ${salesVolatility.toFixed(1)}% volatility - too risky for profitable trading`
            };
        }
    }
    
    // STEP 3: PRICING STRATEGY - Now that we know profit is possible, optimize price
    const listingVsRecentRatio = currentMinPrice / recentMarketAvg;
    
    let basePrice;
    let strategy;
    let confidence;
    let reasoning;
    
    // PROFITABILITY-FIRST PRICING: Start with market analysis but respect minimum profit
    if (listingVsRecentRatio > 1.05) {
        // Current listings are 5%+ above RECENT sales - use recent sales data
        basePrice = Math.max(recentMarketAvg * 0.95, minProfitablePrice);
        strategy = 'RECENT_SALES_BASED';
        reasoning = `Recent-based pricing vs overpriced listings (min profit: €${minProfitablePrice.toFixed(2)})`;
    } else if (listingVsRecentRatio < 0.90) {
        // Current listings are 10%+ below recent sales - competitive opportunity
        basePrice = Math.max(Math.min(currentMinPrice * 0.95, recentMarketAvg * 0.98), minProfitablePrice);
        strategy = 'COMPETITIVE_OPPORTUNITY';
        reasoning = `Competitive opportunity with profit protection (min: €${minProfitablePrice.toFixed(2)})`;
    } else {
        // Listings close to recent sales - hybrid approach
        const recentWeight = recentDataQuality === 'EXCELLENT' ? 0.85 : 0.80;
        const marketPrice = (recentMarketAvg * recentWeight) + (currentMinPrice * 0.95 * (1 - recentWeight));
        basePrice = Math.max(marketPrice, minProfitablePrice);
        strategy = 'PROFIT_PROTECTED_HYBRID';
        reasoning = `Hybrid pricing with profit floor (min: €${minProfitablePrice.toFixed(2)}, market: €${marketPrice.toFixed(2)})`;
    }
    
    // Apply Float Value Intelligence adjustment
    if (floatAnalysis && floatAnalysis.hasFloat && floatAnalysis.floatMultiplier !== 1.0) {
        const preFloatPrice = basePrice;
        basePrice *= floatAnalysis.floatMultiplier;
        reasoning += `, float-adjusted (${floatAnalysis.floatTier}: ${floatAnalysis.floatMultiplier}x from €${preFloatPrice.toFixed(2)} to €${basePrice.toFixed(2)})`;
        
        console.log(`[Float Pricing] Applied ${floatAnalysis.floatTier} float multiplier (${floatAnalysis.floatMultiplier}x): €${preFloatPrice.toFixed(2)} → €${basePrice.toFixed(2)}`);
    }
    
    // Adjust for trend
    if (trend === 'RISING') {
        basePrice *= 1.05; // Price 5% higher in rising market
        reasoning += ', adjusted up for rising trend';
    } else if (trend === 'FALLING') {
        basePrice *= 0.95; // Price 5% lower in falling market
        reasoning += ', adjusted down for falling trend';
    }
    
    // Volume-based confidence (minimal impact on pricing now)
    if (salesVolume >= 8) {
        confidence = 'HIGH';
    } else if (salesVolume >= 4) {
        confidence = 'MEDIUM';
    } else if (salesVolume >= 2) {
        confidence = 'LOW';
    } else {
        confidence = 'VERY_LOW';
    }
    
    // CRITICAL: Apply volatility-based market tolerance cap to ALL pricing
    if (basePrice > marketTolerance) {
        basePrice = marketTolerance;
        reasoning += `, capped at volatility limit (${volatilityCategory}: max ${(marketToleranceMultiplier * 100).toFixed(1)}% of recent avg)`;
        console.log(`[Volatility Cap Applied] Price reduced to €${basePrice.toFixed(2)} due to ${salesVolatility.toFixed(1)}% volatility limit`);
    }
    
    // Final safety check: ensure we don't exceed market maximum
    if (basePrice > salesMax) {
        basePrice = Math.min(salesMax * 0.95, marketTolerance);
        reasoning += ', capped at market maximum';
    }
    
    // Final profit verification
    const finalNetPrice = basePrice * (1 - SKINPORT_FEE);
    const finalProfit = finalNetPrice - buyPrice;
    const finalMargin = (finalProfit / buyPrice) * 100;
    
    console.log(`[Final Pricing] €${basePrice.toFixed(2)} gross → €${finalNetPrice.toFixed(2)} net = €${finalProfit.toFixed(2)} profit (${finalMargin.toFixed(1)}%)`);

    return {
        achievablePrice: basePrice,
        confidence,
        strategy,
        reasoning,
        salesData: {
            median: salesMedian,
            avg: salesAvg,
            min: salesMin,
            max: salesMax,
            volume: salesVolume,
            weeklyVolume: weeklyVolume
        },
        marketContext: {
            listingVsSalesRatio: listingVsRecentRatio.toFixed(2),
            trend,
            velocityCategory: velocityCategory,
            liquidityMargin: (minProfitMargin * 100).toFixed(1) + '%',
            isStableItem: isStableItem,
            salesVolatility: salesVolatility.toFixed(1) + '%',
            currentListingSpread: currentListingSpread.toFixed(1) + '%',
            minProfitRequired: minProfitablePrice,
            floatIntelligence: floatAnalysis ? {
                hasFloat: floatAnalysis.hasFloat,
                floatValue: floatAnalysis.floatValue,
                floatTier: floatAnalysis.floatTier,
                floatMultiplier: floatAnalysis.floatMultiplier,
                wearCondition: floatAnalysis.wearCondition
            } : null
        }
    };
}

/**
 * DUAL-CRITERIA confidence calculation: GREEN requires BOTH profitability AND liquidity
 */
function calculateOverallConfidence(marketData, multiTimeframeData, smartPricing, salesVolume, currentQuantity) {
    const factors = [];
    
    // Extract market data for dual-criteria analysis
    const achievablePrice = smartPricing.achievablePrice;
    const isStableItem = smartPricing.marketContext?.isStableItem || false;
    const velocityCategory = smartPricing.marketContext?.velocityCategory || 'UNKNOWN';
    const minProfitRequired = smartPricing.marketContext?.minProfitRequired || 0;
    
    // Calculate actual profit margins
    const netPrice = achievablePrice * (1 - SKINPORT_FEE);
    const buyPrice = minProfitRequired / (1 + parseFloat(smartPricing.marketContext?.liquidityMargin || '2%') / 100) * (1 - SKINPORT_FEE);
    const actualProfit = netPrice - buyPrice;
    const actualMarginPercent = (actualProfit / buyPrice) * 100;
    
    // Get recent activity data
    const recent24hVolume = multiTimeframeData.allTimeframes.find(t => t.period === '24h')?.data.volume || 0;
    const recent7dVolume = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.volume || 0;
    const hasRecentActivity = recent24hVolume > 0 || recent7dVolume > 0;
    
    // DUAL-CRITERIA SCORING SYSTEM
    
    // CRITERION 1: PROFITABILITY SCORE (0-100)
    let profitabilityScore = 0;
    
    if (actualMarginPercent >= 15) {
        profitabilityScore = 100;
        factors.push(`Excellent profit potential (${actualMarginPercent.toFixed(1)}%)`);
    } else if (actualMarginPercent >= 12) {
        profitabilityScore = 85;
        factors.push(`High profit potential (${actualMarginPercent.toFixed(1)}%)`);
    } else if (actualMarginPercent >= 10) {
        profitabilityScore = 75;
        factors.push(`Good profit potential (${actualMarginPercent.toFixed(1)}%)`);
    } else if (actualMarginPercent >= 8) {
        profitabilityScore = 60;
        factors.push(`Moderate profit potential (${actualMarginPercent.toFixed(1)}%)`);
    } else if (actualMarginPercent >= 5) {
        profitabilityScore = 40;
        factors.push(`Low profit potential (${actualMarginPercent.toFixed(1)}%)`);
    } else if (actualMarginPercent >= 2) {
        profitabilityScore = 20;
        factors.push(`Very low profit potential (${actualMarginPercent.toFixed(1)}%)`);
    } else {
        profitabilityScore = 10;
        factors.push(`Minimal profit potential (${actualMarginPercent.toFixed(1)}%)`);
    }
    
    // Profitability bonus for stable items (easier to achieve target margins)
    if (isStableItem) {
        profitabilityScore = Math.min(profitabilityScore + 10, 100);
        factors.push('Stable item - profit more reliable');
    }
    
    // CRITERION 2: REALISTIC LIQUIDITY SCORE (0-100) - Practical CS:GO market thresholds
    let liquidityScore = 0;
    
    // Recent activity is important but CS:GO markets are naturally low-volume
    if (!hasRecentActivity) {
        liquidityScore = 15; // Still worth considering if no recent sales (was 5%)
        factors.push('No recent sales - will take longer but still viable');
    } else {
        // Base liquidity from recent volume - REALISTIC THRESHOLDS for CS:GO
        if (recent24hVolume >= 3) {
            liquidityScore = 95; // Excellent daily activity - realistic threshold
            factors.push(`Excellent daily liquidity (${recent24hVolume} sales/24h)`);
        } else if (recent24hVolume >= 2) {
            liquidityScore = 85; // Very good daily activity
            factors.push(`Very good daily liquidity (${recent24hVolume} sales/24h)`);
        } else if (recent24hVolume >= 1) {
            liquidityScore = 70; // Good daily activity
            factors.push(`Good daily liquidity (${recent24hVolume} sales/24h)`);
        } else if (recent7dVolume >= 5) {
            liquidityScore = 80; // Good weekly activity
            factors.push(`Good weekly liquidity (${recent7dVolume} sales/7d)`);
        } else if (recent7dVolume >= 3) {
            liquidityScore = 65; // Moderate weekly activity - realistic
            factors.push(`Moderate weekly liquidity (${recent7dVolume} sales/7d)`);
        } else if (recent7dVolume >= 2) {
            liquidityScore = 50; // Acceptable weekly activity
            factors.push(`Acceptable weekly liquidity (${recent7dVolume} sales/7d)`);
        } else if (recent7dVolume >= 1) {
            liquidityScore = 35; // Low but viable weekly activity
            factors.push(`Low weekly liquidity (${recent7dVolume} sales/7d) - manageable risk`);
        } else {
            liquidityScore = 25; // Minimal activity but not hopeless
            factors.push('Minimal recent liquidity - higher risk but possible');
        }
        
        // Velocity category bonus
        if (velocityCategory.includes('HIGH_VELOCITY')) {
            liquidityScore = Math.min(liquidityScore + 10, 100);
            factors.push('High velocity market - fast turnover');
        } else if (velocityCategory.includes('STABLE')) {
            liquidityScore = Math.min(liquidityScore + 15, 100);
            factors.push('Stable market - predictable liquidity');
        } else if (velocityCategory.includes('REALISTIC')) {
            liquidityScore = Math.min(liquidityScore + 8, 100);
            factors.push('Realistic velocity - normal CS:GO market');
        }
        
        // Market quantity factor (not too many, not too few)
        if (currentQuantity >= 3 && currentQuantity <= 25) {
            liquidityScore = Math.min(liquidityScore + 5, 100);
            factors.push('Good market supply balance');
        } else if (currentQuantity > 40) {
            liquidityScore = Math.max(liquidityScore - 15, 15);
            factors.push('Oversupplied market - competitive pricing needed');
        } else if (currentQuantity < 2) {
            liquidityScore = Math.max(liquidityScore - 8, 15);
            factors.push('Limited market supply - may take longer');
        }
    }
    
    // Apply volatility penalty to liquidity score - ENHANCED PENALTIES for realistic trading
    const salesData = smartPricing.salesData;
    if (salesData) {
        const salesVolatility = ((salesData.max - salesData.min) / salesData.avg) * 100;
        if (salesVolatility > 1000) {
            liquidityScore = Math.max(liquidityScore - 80, 5); // Extreme penalty for chaos-level volatility
            factors.push(`EXTREME volatility (${salesVolatility.toFixed(0)}%) - market chaos, avoid trading`);
        } else if (salesVolatility > 500) {
            liquidityScore = Math.max(liquidityScore - 65, 5); // Severe penalty for manipulation-level volatility
            factors.push(`SEVERE volatility (${salesVolatility.toFixed(0)}%) - likely market manipulation`);
        } else if (salesVolatility > 200) {
            liquidityScore = Math.max(liquidityScore - 50, 5); // Major penalty for extreme volatility
            factors.push(`EXTREME volatility (${salesVolatility.toFixed(1)}%) - unpredictable pricing chaos`);
        } else if (salesVolatility > 150) {
            liquidityScore = Math.max(liquidityScore - 40, 10); // Heavy penalty for extreme volatility
            factors.push(`High volatility (${salesVolatility.toFixed(1)}%) - significant timing risk and pricing uncertainty`);
        } else if (salesVolatility > 100) {
            liquidityScore = Math.max(liquidityScore - 30, 10); // Major penalty for very high volatility
            factors.push(`Very high volatility (${salesVolatility.toFixed(1)}%) - major price risk, timing critical`);
        } else if (salesVolatility > 80) {
            liquidityScore = Math.max(liquidityScore - 20, 10); // Moderate penalty
            factors.push(`High volatility (${salesVolatility.toFixed(1)}%) - price timing matters significantly`);
        } else if (salesVolatility > 50) {
            liquidityScore = Math.max(liquidityScore - 12, 10); // Light penalty
            factors.push(`Moderate volatility (${salesVolatility.toFixed(1)}%) - some price risk`);
        } else if (salesVolatility > 25) {
            liquidityScore = Math.max(liquidityScore - 5, 10); // Very light penalty
            factors.push(`Low volatility (${salesVolatility.toFixed(1)}%) - stable pricing`);
        } else {
            // Bonus for very stable items
            liquidityScore = Math.min(liquidityScore + 5, 100);
            factors.push(`Very low volatility (${salesVolatility.toFixed(1)}%) - excellent price stability`);
        }
    }
    
    // REALISTIC DUAL-CRITERIA COLOR CODING SYSTEM for practical CS:GO trading
    let confidenceLevel, colorCode, stabilityRating;
    const overallScore = Math.round((profitabilityScore + liquidityScore) / 2);
    
    // GREEN: Realistic criteria for CS:GO markets (60+ profitability AND 35+ liquidity)
    if (profitabilityScore >= 60 && liquidityScore >= 35) {
        confidenceLevel = 'HIGH';
        colorCode = 'GREEN';
        stabilityRating = 'PROFITABLE_AND_VIABLE';
        factors.push(`GREEN: Good profit (${profitabilityScore}/100) AND viable liquidity (${liquidityScore}/100)`);
    }
    // ORANGE: Either decent profitability OR acceptable liquidity
    else if (profitabilityScore >= 40 || liquidityScore >= 25) {
        confidenceLevel = 'MEDIUM';
        colorCode = 'ORANGE';
        if (profitabilityScore >= 40 && liquidityScore < 25) {
            stabilityRating = 'PROFITABLE_BUT_SLOW';
            factors.push(`ORANGE: Good profit (${profitabilityScore}/100) but slow liquidity (${liquidityScore}/100) - may take longer`);
        } else if (liquidityScore >= 25 && profitabilityScore < 40) {
            stabilityRating = 'LIQUID_BUT_LOW_PROFIT';
            factors.push(`ORANGE: Good liquidity (${liquidityScore}/100) but low profit (${profitabilityScore}/100) - quick but small gains`);
        } else {
            stabilityRating = 'MODERATE_BOTH';
            factors.push(`ORANGE: Moderate overall - P:${profitabilityScore}/100, L:${liquidityScore}/100`);
        }
    }
    // RED: Neither criteria met sufficiently
    else {
        confidenceLevel = 'LOW';
        colorCode = 'RED';
        stabilityRating = 'SPECULATIVE';
        factors.push(`RED: Low profitability (${profitabilityScore}/100) AND liquidity (${liquidityScore}/100) - high risk`);
    }
    
    return {
        level: confidenceLevel,
        score: overallScore,
        factors,
        colorCode,
        stabilityRating,
        dualCriteriaScores: {
            profitabilityScore,
            liquidityScore,
            profitMargin: actualMarginPercent.toFixed(1) + '%',
            recentActivity: `${recent24hVolume}/24h, ${recent7dVolume}/7d`
        },
        profitMetrics: {
            actualMarginPercent: actualMarginPercent.toFixed(1),
            isStableItem,
            velocityCategory,
            hasRecentActivity
        },
        marketMetrics: {
            recentDataQuality: multiTimeframeData.recentDataQuality,
            dataTimeframe: multiTimeframeData.bestTimeframe.period
        }
    };
}

// WEEKLY FLIP Trading Analysis - 3-7 Day Strategy for Best Accuracy & Sales
function analyzeWeeklyFlipViability(itemName, priceData, salesData, trend, stability) {
    const volume = priceData.volume;
    const avgPrice = priceData.avg;
    const maxPrice = priceData.max;
    const minPrice = priceData.min;
    const hasRecentActivity = salesData.last_7_days && salesData.last_7_days.volume > 0;
    
    let score = 0;
    let reasons = [];
    let recommendation = 'AVOID';
    
    // For weekly flips, we need good weekly volume (35% of score) - PERFECT BALANCE THRESHOLDS
    // CRITICAL: Use actual 7d volume when available, fallback to estimate
    const actual7dVolume = salesData.last_7_days?.volume || 0;
    const estimated7dVolume = Math.max(volume / 4, 1);
    const weeklyVolume = actual7dVolume > 0 ? actual7dVolume : estimated7dVolume;
    
    // Log volume calculation for transparency
    if (actual7dVolume > 0 && actual7dVolume !== estimated7dVolume) {
        console.log(`[Volume Calculation] ${itemName}: Using actual 7d volume (${actual7dVolume}) vs estimated (${estimated7dVolume.toFixed(1)})`);
    }
    
    if (weeklyVolume >= 15) { // Quality threshold for excellent weekly volume
        score += 35;
        reasons.push('Excellent weekly volume (15+ sales) - reliable liquidity');
    } else if (weeklyVolume >= 8) { // Balanced threshold for good volume
        score += 30;
        reasons.push('Good weekly volume (8+ sales) - good liquidity');
    } else if (weeklyVolume >= 4) { // Minimum viable threshold for decent volume
        score += 25;
        reasons.push('Moderate weekly volume (4+ sales) - decent liquidity');
    } else if (weeklyVolume >= 2) { // Lower threshold for acceptable volume
        score += 20;
        reasons.push('Low weekly volume (2+ sales) - may take longer');
    } else if (weeklyVolume >= 1) { // Minimum threshold for some activity
        score += 15;
        reasons.push('Very low weekly volume (1+ sales) - higher risk but possible');
    } else {
        score += 10;
        reasons.push('Minimal weekly volume (<1 sales) - HIGH RISK but potential exists');
    }
    
    // Price stability is important for 3-7 day holds (25% of score)
    const priceRange = maxPrice - minPrice;
    const priceStability = 100 - ((priceRange / avgPrice) * 100);
    if (priceStability >= 80) {
        score += 25;
        reasons.push('Very stable pricing (>80%) - low risk');
    } else if (priceStability >= 60) {
        score += 20;
        reasons.push('Stable pricing (60-80%) - manageable risk');
    } else if (priceStability >= 40) {
        score += 15;
        reasons.push('Somewhat stable pricing (40-60%)');
    } else if (priceStability >= 20) {
        score += 10;
        reasons.push('Unstable pricing (20-40%) - higher risk');
    } else {
        reasons.push('Very unstable pricing (<20%) - HIGH RISK');
    }
    
    // Market position - buying in bottom 30% is ideal (20% of score)
    const currentPos = (avgPrice - minPrice) / (maxPrice - minPrice || 1);
    if (currentPos <= 0.3) {
        score += 20;
        reasons.push('Excellent entry point (bottom 30% of range)');
    } else if (currentPos <= 0.5) {
        score += 15;
        reasons.push('Good entry point (below median)');
    } else if (currentPos <= 0.7) {
        score += 10;
        reasons.push('Fair entry point (above median)');
    } else {
        score += 5;
        reasons.push('Poor entry point (top 30% of range)');
    }
    
    // Recent activity check - should have sales within week (20% of score) - PERFECT BALANCE THRESHOLDS
    if (hasRecentActivity) {
        const weeklyVol = salesData.last_7_days.volume;
        if (weeklyVol >= 8) { // Quality threshold for high activity
            score += 20;
            reasons.push('High weekly activity (8+ sales this week)');
        } else if (weeklyVol >= 4) { // Balanced threshold for good activity
            score += 17;
            reasons.push('Good weekly activity (4+ sales this week)');
        } else if (weeklyVol >= 2) { // Minimum viable threshold
            score += 15;
            reasons.push('Moderate weekly activity (2+ sales this week)');
        } else if (weeklyVol >= 1) { // Minimum activity threshold
            score += 12;
            reasons.push('Low weekly activity (1+ sales this week)');
        } else {
            score += 8;
            reasons.push('Minimal weekly activity but still trackable');
        }
    } else {
        score += 5;
        reasons.push('No recent weekly activity data - estimated from total volume');
    }
    
    // Determine recommendation for weekly flips - PERFECT BALANCE THRESHOLDS
    if (score >= 50) { // Easier to achieve excellent rating
        recommendation = 'WEEKLY_FLIP_EXCELLENT';
    } else if (score >= 30) { // Easier to achieve good rating
        recommendation = 'WEEKLY_FLIP_GOOD';
    } else if (score >= 15) { // Easier to achieve moderate rating
        recommendation = 'WEEKLY_FLIP_MODERATE';
    } else {
        recommendation = 'AVOID_WEEKLY_FLIP';
    }
    
    // Calculate weekly flip metrics - PERFECT BALANCE ADJUSTMENTS + REALISTIC VOLUME CONSIDERATION
    let estimatedSellDays = '5-7'; // Default estimate
    let targetMarginPercentage = 10; // Realistic margins for weekly flips
    let sellProbability = 60;
    
    // CRITICAL: Adjust estimates based on actual recent volume and pricing position
    const recent7dAvg = salesData.last_7_days?.avg || avgPrice;
    
    if (score >= 50) { // Perfect balance threshold
        estimatedSellDays = actual7dVolume <= 2 ? '5-10' : '1-3'; // Reality check for low volume
        targetMarginPercentage = 12;
        sellProbability = actual7dVolume <= 2 ? 70 : 90; // Lower probability for low volume
    } else if (score >= 30) { // Perfect balance threshold
        estimatedSellDays = actual7dVolume <= 2 ? '7-12' : '3-5'; // Reality check for low volume
        targetMarginPercentage = 10;
        sellProbability = actual7dVolume <= 2 ? 60 : 75; // Lower probability for low volume
    } else if (score >= 15) { // Perfect balance threshold
        estimatedSellDays = '5-7';
        targetMarginPercentage = 8;
        sellProbability = 60;
    } else {
        estimatedSellDays = '7+';
        targetMarginPercentage = 15;
        sellProbability = 40;
    }
    
    // Additional penalty for pricing significantly above recent sales
    if (avgPrice > recent7dAvg * 1.15) { // 15% above recent average
        estimatedSellDays = estimatedSellDays === '1-3' ? '7-14' :
                           estimatedSellDays === '3-5' ? '7-14' :
                           estimatedSellDays === '5-7' ? '10-21' :
                           estimatedSellDays === '5-10' ? '14-28' : estimatedSellDays;
        sellProbability = Math.max(sellProbability - 20, 30);
        reasons.push(`Pricing ${((avgPrice/recent7dAvg - 1) * 100).toFixed(1)}% above recent 7d average - extended timeline`);
    }
    
    return {
        score,
        recommendation,
        reasons,
        estimatedSellDays,
        targetMarginPercentage,
        sellProbability,
        hasRecentActivity,
        priceStability: priceStability.toFixed(1),
        weeklyVolume: Math.round(weeklyVolume)
    };
}

// Calculate weekly flip selling strategy - balanced pricing for 3-7 day sales
function calculateWeeklyFlipStrategy(buyPrice, marketData, viability) {
    const avg = marketData.avg;
    const max = marketData.max;
    const min = marketData.min;
    
    // For weekly flips, we can price closer to average but still competitive
    // Target 75th-90th percentile for good balance of speed and profit
    
    // Quick sale pricing (3-4 days): 75th percentile 
    const quickSalePrice = min + ((avg - min) * 0.75);
    
    // Standard pricing (4-6 days): 80th percentile
    const standardPrice = min + ((avg - min) * 0.80);
    
    // Patient pricing (5-7 days): 85th percentile
    const patientPrice = min + ((avg - min) * 0.85);
    
    // Choose pricing based on viability and desired sell time
    let recommendedPrice;
    let expectedDays;
    
    if (viability.recommendation === 'WEEKLY_FLIP_EXCELLENT' && viability.score >= 50) { // Perfect balance threshold
        recommendedPrice = patientPrice; // Can afford to wait for better price
        expectedDays = '2-4';
    } else if (viability.recommendation === 'WEEKLY_FLIP_GOOD') {
        recommendedPrice = standardPrice; // Balanced approach
        expectedDays = '3-5';
    } else {
        recommendedPrice = quickSalePrice; // Price aggressively to ensure sale
        expectedDays = '4-7';
    }
    
    // Ensure minimum profit margin
    const minProfitMargin = 0.08; // 8% minimum
    const minPrice = buyPrice * (1 + minProfitMargin);
    if (recommendedPrice < minPrice) {
        recommendedPrice = minPrice;
        expectedDays = '5-7'; // Might take longer with higher price
    }
    
    return {
        quick: quickSalePrice,
        standard: standardPrice,
        patient: patientPrice,
        recommended: recommendedPrice,
        expectedProfit: recommendedPrice - buyPrice,
        expectedMargin: ((recommendedPrice - buyPrice) / buyPrice) * 100,
        expectedDays
    };
}

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter that respects Skinport's 8 requests per 5 minutes limit.
 * We use 5 requests per 5 minutes to be conservative.
 */
async function waitForRateLimit() {
    const now = Date.now();
    
    // Remove old requests from the queue
    while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT_WINDOW) {
        requestQueue.shift();
    }

    console.log(`[Rate Limiter] Current queue: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW} requests in last ${RATE_LIMIT_WINDOW/1000}s`);

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        // Queue is full, wait for the oldest request to expire
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now + 2000; // +2s buffer
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Rate limit reached. Waiting ${Math.round(timeToWait/1000)}s for the next available slot.`);
            await delay(timeToWait);
            
            // Clean up queue again after waiting
            const afterWait = Date.now();
            while (requestQueue.length > 0 && afterWait - requestQueue[0] > RATE_LIMIT_WINDOW) {
                requestQueue.shift();
            }
        }
    }
    
    // Add the new request timestamp to the queue
    requestQueue.push(Date.now());
    console.log(`[Rate Limiter] Request added. Queue now: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW}`);
}

/**
 * Creates optimal batches based on URL length limits
 */
function createOptimalBatches(uniqueItems, maxUrlLength = 7000) {
    const batches = [];
    let currentBatch = [];
    let currentUrlLength = SKINPORT_API_URL.length + 100; // Base URL + params overhead
    
    // Helper function to clean and validate item names - MUCH MORE PERMISSIVE
    const cleanItemName = (name) => {
        // Only trim whitespace and normalize spaces - preserve all other characters
        return name.trim()
            .replace(/\s+/g, ' ');          // Normalize spaces only
    };

    // Filter and clean items before batching
    const validItems = uniqueItems
        .map(item => cleanItemName(item))
        .filter(item => {
            const isValid = item.length > 0 && item.length < 150; // Increased limit
            if (!isValid) {
                console.log(`[Batch] Skipping invalid item name: ${item}`);
            }
            return isValid;
        });
    
    for (const item of validItems) {
        const itemLength = encodeURIComponent(item).length + 1; // +1 for comma
        
        // If adding this item would exceed URL limit or we hit reasonable batch size
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 100) { // Increased to 100 items per batch for better efficiency while avoiding URL length issues
            if (currentBatch.length > 0) {
                batches.push([...currentBatch]);
                currentBatch = [];
                currentUrlLength = SKINPORT_API_URL.length + 100;
            }
        }
        
        currentBatch.push(item);
        currentUrlLength += itemLength;
    }
    
    // Add remaining items
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    
    return batches;
}

/**
 * Fetches ALL Skinport items with current market data (prices, quantities)
 */
async function fetchAllSkinportItems(currency) {
    const cacheKey = `all_items_${currency}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        console.log(`[Cache] All items cache hit`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency
        });
        
        const url = `${SKINPORT_API_URL}/items?${params}`;
        console.log(`[API Call] Fetching ALL Skinport items for current market data`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            console.error(`[API Error] Failed to fetch all Skinport items. Status: ${response.status}`);
            return {};
        }

        const data = await response.json();
        console.log(`[API Response] Received ${data.length} total Skinport items`);
        
        // Convert to lookup object by market_hash_name
        const itemsLookup = {};
        data.forEach(item => {
            if (item.market_hash_name) {
                itemsLookup[item.market_hash_name] = {
                    market_hash_name: item.market_hash_name,
                    min_price: item.min_price,
                    max_price: item.max_price,
                    mean_price: item.mean_price,
                    median_price: item.median_price,
                    quantity: item.quantity,
                    created_at: item.created_at,
                    updated_at: item.updated_at
                };
            }
        });
        
        // Cache for 5 minutes
        cache.set(cacheKey, itemsLookup);
        console.log(`[Cache] All items cached: ${Object.keys(itemsLookup).length} items`);
        
        return itemsLookup;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching all Skinport items: ${error.message}`);
        return {};
    }
}

/**
 * Fetches sales history for multiple items in a single API call
 */
async function fetchSalesHistoryBatch(marketHashNames, currency) {
    // Validate and clean market hash names
    const validNames = marketHashNames.filter(name => {
        const isValid = typeof name === 'string' && 
                       name.trim().length > 0 && 
                       name.length < 200;
        
        if (!isValid) {
            console.log(`[API] Skipping invalid market_hash_name: ${name}`);
        }
        return isValid;
    }).map(name => name.trim());

    if (validNames.length === 0) {
        console.log(`[API] No valid items in batch`);
        return {};
    }

    const batchKey = `sales_history_${validNames.sort().join(',')}_${currency}`;
    const cachedData = cache.get(batchKey);

    if (cachedData) {
        console.log(`[Cache] Sales history cache hit for ${validNames.length} items`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        const marketHashNamesParam = validNames.join(',');
            
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency,
            market_hash_name: marketHashNamesParam
        });
        
        const url = `${SKINPORT_API_URL}/sales/history?${params}`;
        console.log(`[API Call] Fetching sales history for batch of ${validNames.length} items`);
        console.log(`[API Call] Sample names:`, validNames.slice(0, 3));
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            const responseText = await response.text();
            console.error(`[API Error] Failed to fetch sales history. Status: ${response.status} ${response.statusText}`);
            console.error(`[API Error] Response body: ${responseText.substring(0, 200)}...`);
            
            // Add retry logic for 502 errors
            if (response.status === 502) {
                console.log('[API Error] Received 502 Bad Gateway, waiting 5 seconds before retry...');
                await delay(5000);
                
                const retryResponse = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Accept-Encoding': 'br',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                if (retryResponse.ok) {
                    return await retryResponse.json();
                } else {
                    console.error('[API Error] Retry also failed');
                }
            }
            
            return {};
        }

        const data = await response.json();
        console.log(`[API Response] Sales history received for ${data.length} items`);
        
        // Convert array response to object with market_hash_name as key
        const batchData = {};
        if (Array.isArray(data)) {
            data.forEach(item => {
                if (item.market_hash_name) {
                    batchData[item.market_hash_name] = item;
                }
            });
        }
        
        // Cache the batch response
        cache.set(batchKey, batchData);
        console.log(`[Cache] Sales history cached for ${validNames.length} items`);
        
        return batchData;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching sales history: ${error.message}`);
        return {};
    }
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for analysis.`);
    console.log(`[Backend] Sample items:`, items.slice(0, 3));

    try {
        const analyzedItems = [];
        
        // Extract unique market hash names (item names)
        const uniqueNames = [...new Set(items.map(item => {
            const rawName = item.marketHashName || item.name;
            return normalizeItemName(rawName);
        }).filter(name => name && name.trim()))];
        console.log(`[Backend] Extracted ${uniqueNames.length} unique item names.`);

        if (uniqueNames.length === 0) {
            return res.json({ 
                analyzedItems, 
                summary: { totalProcessed: 0, profitableFound: 0, message: 'No valid item names found' }
            });
        }

        // Fetch BOTH current market data AND sales history
        console.log(`[Backend] Fetching current market data for all items...`);
        const allMarketData = await fetchAllSkinportItems(settings.currency || 'EUR');
        
        console.log(`[Backend] Fetching sales history in batches...`);
        const batches = createOptimalBatches(uniqueNames);
        console.log(`[Backend] Split into ${batches.length} batches.`);

        // Fetch sales history for all batches
        const allSalesData = {};
        for (let i = 0; i < batches.length; i++) {
            console.log(`[Backend] Processing sales history batch ${i + 1}/${batches.length} (${batches[i].length} items)`);
            const batchData = await fetchSalesHistoryBatch(batches[i], settings.currency || 'EUR');
            Object.assign(allSalesData, batchData);
            
            // Delay between batches for rate limiting
            if (i < batches.length - 1) {
                console.log(`[Backend] Waiting 5 seconds before next batch...`);
                await delay(5000);
            }
        }

        console.log(`[Backend] Got market data for ${Object.keys(allMarketData).length} items`);
        console.log(`[Backend] Got sales history for ${Object.keys(allSalesData).length} items`);

        // Analyze each item for profitability using BOTH current market + sales history
        for (const item of items) {
            const rawItemName = item.marketHashName || item.name;
            const itemName = normalizeItemName(rawItemName);
            const itemPrice = item.price || item.skinportPrice;
            
            if (!itemName || !itemPrice) continue;

            // Skip Battle-Scarred items as requested (avoid low-demand wear condition)
            if (itemName.includes('Battle-Scarred')) {
                console.log(`[Filter] Skipping Battle-Scarred item: ${itemName}`);
                continue;
            }

            // Get both current market data AND sales history
            const marketData = allMarketData[itemName];
            const salesData = allSalesData[itemName];
            
            if (!marketData) {
                console.log(`[Backend] No current market data for: ${itemName}`);
                continue;
            }
            
            if (!salesData) {
                console.log(`[Backend] No sales history for: ${itemName}`);
                continue;
            }

            // Debug: Log the structure for first few items
            if (analyzedItems.length < 3) {
                console.log(`[Debug] Market data for "${itemName}":`, JSON.stringify(marketData, null, 2));
                console.log(`[Debug] Sales data for "${itemName}":`, JSON.stringify(salesData, null, 2).substring(0, 500) + '...');
            }

            // Extract current market data (what people are selling for NOW)
            const currentMinPrice = marketData.min_price;
            const currentMaxPrice = marketData.max_price;
            const currentMeanPrice = marketData.mean_price;
            const currentMedianPrice = marketData.median_price;
            const currentQuantity = marketData.quantity;
            
            if (!currentMinPrice || currentMinPrice <= 0) {
                console.log(`[Backend] No valid current market price for: ${itemName}`);
                continue;
            }

            // Extract sales history data using multi-timeframe analysis
            const multiTimeframeAnalysis = analyzeMultiTimeframe(salesData);
            if (!multiTimeframeAnalysis) {
                console.log(`[Backend] No valid timeframe data for: ${itemName} - insufficient sales volume`);
                continue;
            }
            
            const priceData = multiTimeframeAnalysis.bestTimeframe.data;
            const timeframePeriod = multiTimeframeAnalysis.bestTimeframe.period;
            
            console.log(`[Multi-Timeframe] ${itemName}: Using ${timeframePeriod} data (${priceData.volume} sales, trend: ${multiTimeframeAnalysis.trend})`);
            
            // SMART ACHIEVABLE PRICE: Use actual sales data for realistic pricing
            const skinportBuyPrice = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            
            // Float Value Intelligence Analysis
            const floatAnalysis = analyzeFloatValue(itemName, skinportBuyPrice);
            console.log(`[Float Intelligence] ${itemName}: ${floatAnalysis.floatAnalysis}`);
            
            // Apply float-adjusted expectations to minimum price
            const floatAdjustedMinPrice = currentMinPrice * floatAnalysis.floatMultiplier;
            if (floatAnalysis.hasFloat && floatAnalysis.floatMultiplier !== 1.0) {
                console.log(`[Float Intelligence] Float-adjusted competitive price: €${floatAdjustedMinPrice.toFixed(2)} (${floatAnalysis.floatTier} float: ${floatAnalysis.floatMultiplier}x)`);
            }
            
            // Use float-adjusted competitive price for calculations
            const workingMinPrice = floatAdjustedMinPrice;
            
            // Calculate smart achievable price based on sales data
            const smartPricing = calculateSmartAchievablePrice(skinportBuyPrice, marketData, multiTimeframeAnalysis, workingMinPrice, floatAnalysis);
            
            // Handle market-rejected items (pricing exceeds market reality)
            if (smartPricing.achievablePrice === 0 || smartPricing.confidence === 'REJECTED') {
                console.log(`[Market Reality] ${itemName}: ${smartPricing.reasoning} - skipping`);
                continue;
            }
            
            const achievableGrossPrice = smartPricing.achievablePrice;
            const achievableNetPrice = achievableGrossPrice * (1 - SKINPORT_FEE);
            
            // Calculate profit
            const profitAmount = achievableNetPrice - skinportBuyPrice;
            const profitPercentage = (profitAmount / skinportBuyPrice) * 100;
            
            console.log(`[Smart Pricing] ${itemName}:`);
            console.log(`  Strategy: ${smartPricing.strategy}`);
            console.log(`  Reasoning: ${smartPricing.reasoning}`);
            console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}`);
            if (floatAnalysis.hasFloat) {
                console.log(`  Float Value: ${floatAnalysis.floatValue} (${floatAnalysis.wearCondition} ${floatAnalysis.floatTier})`);
            }
            console.log(`  Achievable Price: €${achievableGrossPrice.toFixed(2)} → €${achievableNetPrice.toFixed(2)} net`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            console.log(`  Confidence: ${smartPricing.confidence}`);
            
            // Skip items with no profit potential (should be rare now due to market reality checks)
            if (profitAmount <= 0) {
                console.log(`[Smart Pricing] ${itemName}: No profit potential - skipping`);
                continue;
            }
            
            // Apply user's minimum criteria (only basic filters now)
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);
            
            if (profitAmount < minProfitAmount || profitPercentage < minProfitPercentage) {
                console.log(`[Smart Pricing] ${itemName}: Below user minimum (€${profitAmount.toFixed(2)}, ${profitPercentage.toFixed(1)}%) - skipping`);
                continue;
            }
            
            // Calculate overall confidence using enhanced system with color coding
            const overallConfidence = calculateOverallConfidence(
                marketData, 
                multiTimeframeAnalysis, 
                smartPricing, 
                priceData.volume, 
                currentQuantity
            );
            
            // Calculate alternative pricing strategies for comparison
            const competitivePrice = currentMinPrice * 0.95;
            const conservativePrice = currentMinPrice * 0.90;
            const aggressivePrice = currentMinPrice * 0.98;
            
            // Enhanced time estimate based on confidence, market conditions, and recent data quality
            let timeEstimate;
            const recentDataQuality = multiTimeframeAnalysis.recentDataQuality;
            
            if (overallConfidence.level === 'HIGH' && recentDataQuality === 'EXCELLENT') {
                timeEstimate = '1-3 days';
            } else if (overallConfidence.level === 'HIGH') {
                timeEstimate = '2-4 days';
            } else if (overallConfidence.level === 'MEDIUM' && recentDataQuality === 'EXCELLENT') {
                timeEstimate = '2-5 days';
            } else if (overallConfidence.level === 'MEDIUM') {
                timeEstimate = '3-7 days';
            } else {
                timeEstimate = '5-10 days';
            }
            
            // Get recent sales data for better market context
            const recent24hData = multiTimeframeAnalysis.allTimeframes.find(t => t.period === '24h')?.data;
            const recent7dData = multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d')?.data;
            const recentAvg = recent24hData?.avg || recent7dData?.avg || priceData.avg;
            
            // Validate pricing against sales history
            const salesAvgPrice = priceData.avg;
            const salesMinPrice = priceData.min;
            const salesMaxPrice = priceData.max;
            const salesVolume = priceData.volume;
            
            // Market analysis
            const pricePosition = (achievableGrossPrice - salesMinPrice) / (salesMaxPrice - salesMinPrice);
            const marketSpread = currentMaxPrice - currentMinPrice;
            const marketVolatility = (marketSpread / currentMeanPrice) * 100;
            
            // Calculate weekly flip viability and enhanced sell time estimates
            const weeklyFlipAnalysis = analyzeWeeklyFlipViability(itemName, priceData, salesData, multiTimeframeAnalysis.trend, marketVolatility);
            
            // Enhanced sell time estimate based on weekly flip analysis
            let enhancedTimeEstimate = timeEstimate; // Default from confidence
            if (weeklyFlipAnalysis && weeklyFlipAnalysis.estimatedSellDays) {
                enhancedTimeEstimate = weeklyFlipAnalysis.estimatedSellDays;
            }
            
            // CRITICAL: Recent Volume Reality Check - Override optimistic estimates for low recent activity
            // This fixes cases like StatTrak™ SSG 08 Blood in the Water where 90d volume is high but recent activity is minimal
            const recentVolume24h = multiTimeframeAnalysis.allTimeframes.find(t => t.period === '24h')?.data.volume || 0;
            const recentVolume7d = multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d')?.data.volume || 0;
            const priceAboveRecent7dAvg = achievableGrossPrice > (multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d')?.data.avg || 0);
            
            // High-value items (>€150) with low recent volume need realistic time estimates
            if (skinportBuyPrice > 150) {
                if (recentVolume24h <= 1 && recentVolume7d <= 3) {
                    enhancedTimeEstimate = '7-14 days';
                    console.log(`[Volume Reality] ${itemName}: High-value item (€${skinportBuyPrice.toFixed(2)}) with low recent activity (24h: ${recentVolume24h}, 7d: ${recentVolume7d}) - realistic time estimate: ${enhancedTimeEstimate}`);
                } else if (recentVolume7d <= 5 && priceAboveRecent7dAvg) {
                    enhancedTimeEstimate = enhancedTimeEstimate === '1-3' ? '5-10 days' : 
                                          enhancedTimeEstimate === '3-5' ? '7-12 days' : enhancedTimeEstimate;
                    console.log(`[Volume Reality] ${itemName}: Pricing above recent 7d average with limited volume (7d: ${recentVolume7d}) - adjusted time estimate: ${enhancedTimeEstimate}`);
                }
            }
            
            // For any item with extremely low recent volume, prevent overly optimistic estimates
            if (recentVolume7d <= 1 && enhancedTimeEstimate === '1-3') {
                enhancedTimeEstimate = '7-14 days';
                console.log(`[Volume Reality] ${itemName}: Only ${recentVolume7d} sale(s) in 7 days - preventing overly optimistic 1-3 day estimate`);
            }
            
            // Calculate market metrics for volatility display
            const marketMetrics = {
                vol7: marketVolatility / 100, // Convert to decimal for percentage display
                volatilityLevel: marketVolatility > 15 ? 'HIGH' : marketVolatility > 8 ? 'MEDIUM' : 'LOW',
                priceStability: weeklyFlipAnalysis ? weeklyFlipAnalysis.priceStability : 'Unknown'
            };
            
            // Create analyzed item with smart pricing
            analyzedItems.push({
                ...item,
                name: itemName,
                skinportPrice: itemPrice,
                
                // Current market data (what's listed now)
                currentMinPrice: currentMinPrice.toFixed(2),
                currentMaxPrice: currentMaxPrice.toFixed(2),
                currentMeanPrice: currentMeanPrice.toFixed(2),
                currentMedianPrice: currentMedianPrice.toFixed(2),
                currentQuantity: currentQuantity,
                
                // Sales history data (what actually sold)
                salesAvgPrice: salesAvgPrice.toFixed(2),
                salesMinPrice: salesMinPrice.toFixed(2),
                salesMaxPrice: salesMaxPrice.toFixed(2),
                salesVolume: salesVolume,
                timeframePeriod: timeframePeriod,
                
                // Smart pricing results
                achievablePrice: achievableNetPrice.toFixed(2), // What you'll actually get after fees
                grossAchievablePrice: achievableGrossPrice.toFixed(2), // What to list at before fees
                profitAmount: profitAmount.toFixed(2),
                profitPercentage: profitPercentage.toFixed(1),
                
                // Float Value Intelligence
                floatIntelligence: floatAnalysis.hasFloat ? {
                    floatValue: floatAnalysis.floatValue,
                    wearCondition: floatAnalysis.wearCondition,
                    floatTier: floatAnalysis.floatTier,
                    floatMultiplier: floatAnalysis.floatMultiplier,
                    floatAnalysis: floatAnalysis.floatAnalysis,
                    floatPosition: floatAnalysis.floatPosition ? (floatAnalysis.floatPosition * 100).toFixed(1) + '%' : null
                } : null,
                
                // Confidence and market analysis with color coding
                confidence: overallConfidence.level,
                confidenceScore: overallConfidence.score,
                confidenceFactors: overallConfidence.factors,
                confidenceColor: overallConfidence.colorCode,
                stabilityRating: overallConfidence.stabilityRating,
                timeEstimate: enhancedTimeEstimate,
                pricingStrategy: smartPricing.strategy,
                pricingReasoning: smartPricing.reasoning,
                trend: multiTimeframeAnalysis.trend,
                pricePosition: Math.round(pricePosition * 100),
                marketVolatility: marketVolatility.toFixed(1),
                
                // Enhanced market context with recent data priority
                recentMarketData: {
                    dataQuality: multiTimeframeAnalysis.recentDataQuality,
                    timeframe: timeframePeriod,
                    recentAvg: recentAvg.toFixed(2),
                    vs24h: recent24hData ? `€${recent24hData.avg.toFixed(2)} (${recent24hData.volume} sales)` : 'No data',
                    vs7d: recent7dData ? `€${recent7dData.avg.toFixed(2)} (${recent7dData.volume} sales)` : 'No data',
                    priceSpread: overallConfidence.marketMetrics.priceSpread + '%'
                },
                
                // Market metrics for volatility display
                metrics: marketMetrics,
                
                // Weekly flip trading analysis
                weeklyFlipTrading: weeklyFlipAnalysis ? {
                    score: weeklyFlipAnalysis.score,
                    recommendation: weeklyFlipAnalysis.recommendation,
                    estimatedSellDays: weeklyFlipAnalysis.estimatedSellDays,
                    weeklyVolume: weeklyFlipAnalysis.weeklyVolume,
                    priceStability: weeklyFlipAnalysis.priceStability,
                    sellProbability: weeklyFlipAnalysis.sellProbability,
                    reasons: weeklyFlipAnalysis.reasons
                } : null,
                
                // Alternative pricing strategies for comparison
                strategies: {
                    smart: {
                        price: achievableGrossPrice.toFixed(2),
                        netPrice: achievableNetPrice.toFixed(2),
                        profit: profitAmount.toFixed(2),
                        profitPercent: profitPercentage.toFixed(1)
                    },
                    aggressive: {
                        price: aggressivePrice.toFixed(2),
                        netPrice: (aggressivePrice * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((aggressivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((aggressivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    },
                    competitive: {
                        price: competitivePrice.toFixed(2),
                        netPrice: (competitivePrice * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((competitivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((competitivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    },
                    conservative: {
                        price: conservativePrice.toFixed(2),
                        netPrice: (conservativePrice * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((conservativePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((conservativePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    }
                },
                
                // Recommendation based on confidence and profit (REALISTIC MARKET-BASED MARGINS)
                recommendation: overallConfidence.level === 'HIGH' && profitPercentage > 3 ? 'STRONG_BUY' :
                               overallConfidence.level === 'HIGH' && profitPercentage > 1.5 ? 'BUY' :
                               overallConfidence.level === 'MEDIUM' && profitPercentage > 4 ? 'BUY' :
                               overallConfidence.level === 'MEDIUM' && profitPercentage > 2 ? 'CONSIDER' :
                               profitPercentage > 0.8 ? 'CONSIDER' : 'HOLD'
            });
            
            console.log(`[Smart Analysis] ${itemName}:`);
            console.log(`  Confidence: ${overallConfidence.level} (${overallConfidence.score}/100)`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            console.log(`  Time Estimate: ${timeEstimate}`);
            console.log(`  Strategy: ${smartPricing.strategy}`);
        }

        console.log(`[Backend] Analysis complete. Found ${analyzedItems.length} profitable items.`);
        
        // Add debug logging for item matching
        console.log(`[DEBUG] Final item names for matching:`);
        analyzedItems.slice(0, 5).forEach((item, index) => {
            console.log(`  ${index + 1}. Server: "${item.marketHashName}" | Wear: "${item.wear}" | Profit: €${item.profitAmount}`);
        });
        
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                uniqueItemsChecked: uniqueNames.length,
                marketDataFound: Object.keys(allMarketData).length,
                salesDataFound: Object.keys(allSalesData).length,
                strategy: 'Smart multi-timeframe pricing with sales data analysis',
                timeframe: 'Dynamic (24h, 7d, 30d, 90d)',
                algorithm: 'Enhanced smart pricing v2.0'
            }
        });
    } catch (error) {
        console.error(`[Backend] Failed to analyze prices: ${error}`);
        res.status(500).json({ error: 'Failed to process items.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rateLimit: {
            requestsInQueue: requestQueue.length,
            maxRequests: MAX_REQUESTS_PER_WINDOW,
            windowMinutes: 5
        }
    });
});

// Start Express server
app.listen(port, () => {
    console.log(`Enhanced Skinport Tracker API listening on port ${port}`);
    console.log(`Server started successfully with basic API endpoint`);
});
