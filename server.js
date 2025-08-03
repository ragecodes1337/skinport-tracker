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
    
    // RECENT-FIRST Selection Logic:
    // 1. Prefer 24h if volume >= 3 (strong recent activity)
    // 2. Prefer 7d if volume >= 5 (good weekly pattern)
    // 3. Use 30d only if recent data insufficient
    // 4. Avoid 90d for pricing (use only for trend)
    
    let bestTimeframe;
    
    // First choice: 24h with decent volume
    const tf24h = timeframes.find(t => t.period === '24h');
    if (tf24h && tf24h.data.volume >= 3) {
        bestTimeframe = tf24h;
        console.log(`[Timeframe Selection] Using 24h data: ${tf24h.data.volume} sales, €${tf24h.data.avg.toFixed(2)} avg - RECENT MARKET REALITY`);
    }
    // Second choice: 7d with good volume
    else {
        const tf7d = timeframes.find(t => t.period === '7d');
        if (tf7d && tf7d.data.volume >= 5) {
            bestTimeframe = tf7d;
            console.log(`[Timeframe Selection] Using 7d data: ${tf7d.data.volume} sales, €${tf7d.data.avg.toFixed(2)} avg - WEEKLY PATTERN`);
        }
        // Third choice: 7d with any volume (better than 30d/90d)
        else if (tf7d && tf7d.data.volume >= 2) {
            bestTimeframe = tf7d;
            console.log(`[Timeframe Selection] Using 7d data: ${tf7d.data.volume} sales, €${tf7d.data.avg.toFixed(2)} avg - LIMITED WEEKLY DATA`);
        }
        // Fallback: 30d only if absolutely necessary
        else {
            const tf30d = timeframes.find(t => t.period === '30d');
            if (tf30d && tf30d.data.volume >= 8) {
                bestTimeframe = tf30d;
                console.log(`[Timeframe Selection] Fallback to 30d data: ${tf30d.data.volume} sales, €${tf30d.data.avg.toFixed(2)} avg - MONTHLY FALLBACK`);
            }
            // Last resort: any available data
            else {
                bestTimeframe = timeframes.reduce((best, current) => {
                    return current.recency < best.recency ? current : best;
                });
                console.log(`[Timeframe Selection] Last resort: ${bestTimeframe.period} data - LIMITED MARKET DATA`);
            }
        }
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
    
    return {
        bestTimeframe,
        allTimeframes: timeframes,
        trend,
        confidence: timeframes.length >= 2 ? 'HIGH' : timeframes.length === 1 ? 'MEDIUM' : 'LOW',
        recentDataQuality: recent24h ? 'EXCELLENT' : recent7d ? 'GOOD' : 'LIMITED'
    };
}

/**
 * Smart achievable price calculation using actual sales data
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
    
    // Get most recent average for reality check
    const recent24hAvg = multiTimeframeData.allTimeframes.find(t => t.period === '24h')?.data.avg;
    const recent7dAvg = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.avg;
    const recentMarketAvg = recent24hAvg || recent7dAvg || salesAvg;
    
    console.log(`[Recent Market Check] Using ${recent24hAvg ? '24h' : recent7dAvg ? '7d' : bestPeriod} avg: €${recentMarketAvg.toFixed(2)} vs current min: €${currentMinPrice.toFixed(2)}`);
    
    // Check if current listings are realistic compared to RECENT sales
    const listingVsRecentRatio = currentMinPrice / recentMarketAvg;
    
    let basePrice;
    let strategy;
    let confidence;
    let reasoning;
    
    if (listingVsRecentRatio > 1.2) {
        // Current listings are 20%+ above RECENT sales - use recent sales data
        basePrice = recentMarketAvg * 0.95; // Price just below recent average
        strategy = 'RECENT_SALES_BASED';
        reasoning = `Current listings overpriced vs recent ${recent24hAvg ? '24h' : '7d'} avg (€${recentMarketAvg.toFixed(2)})`;
    } else if (listingVsRecentRatio < 0.85) {
        // Current listings are 15%+ below recent sales - competitive opportunity
        basePrice = Math.min(currentMinPrice * 0.95, recentMarketAvg * 0.98);
        strategy = 'COMPETITIVE_OPPORTUNITY';
        reasoning = 'Current listings below recent market average - opportunity';
    } else {
        // Listings aligned with recent sales - hybrid approach favoring recent data
        const recentWeight = recentDataQuality === 'EXCELLENT' ? 0.8 : 0.7;
        basePrice = (recentMarketAvg * recentWeight) + (currentMinPrice * 0.95 * (1 - recentWeight));
        strategy = 'RECENT_HYBRID';
        reasoning = `Balanced pricing based on recent ${bestPeriod} data`;
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
    
    // Adjust for volume (confidence factor) - MINIMAL PENALTIES for maximum opportunities
    if (salesVolume >= 8) { // Lowered from 10, quality-focused
        confidence = 'HIGH';
    } else if (salesVolume >= 4) { // Lowered from 5, balanced approach
        confidence = 'MEDIUM';
    } else if (salesVolume >= 2) {
        confidence = 'LOW';
        basePrice *= 0.995; // Minimal penalty from 0.99 (was 1% penalty, now 0.5%)
    } else {
        confidence = 'VERY_LOW';
        basePrice *= 0.99; // Minimal penalty from 0.97 (was 3% penalty, now 1%)
    }
    
    // RECENT MARKET REALITY CHECK - Don't force profit where recent market won't support it
    const recentMarketTolerance = recentMarketAvg * 1.08; // Max 108% of recent sales average (tighter than old 110%)
    
    if (basePrice > recentMarketTolerance) {
        console.log(`[Recent Market Reality] ${buyPrice.toFixed(2)} item: basePrice €${basePrice.toFixed(2)} exceeds recent market tolerance €${recentMarketTolerance.toFixed(2)} (108% of €${recentMarketAvg.toFixed(2)} recent avg) - REJECTING`);
        return {
            achievablePrice: 0, // Signal rejection
            confidence: 'REJECTED',
            strategy: 'RECENT_MARKET_REJECTED',
            reasoning: `Price €${basePrice.toFixed(2)} exceeds recent market reality (108% of €${recentMarketAvg.toFixed(2)} ${recent24hAvg ? '24h' : '7d'} avg)`
        };
    }
    
    // LIQUIDITY-BASED PROFIT MARGINS - Calculate sales velocity and adjust margins accordingly
    const weeklyVolume = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.volume || 
                        Math.max(salesVolume / 4, 1); // Estimate weekly volume or minimum 1
    
    let minProfitMargin;
    let velocityCategory;
    
    // High velocity items (8+ sales/week) - Fast flips, lower margins acceptable
    if (weeklyVolume >= 8) {
        velocityCategory = 'HIGH_VELOCITY';
        if (buyPrice < 20) {
            minProfitMargin = 0.008; // 0.8% for small, fast-moving items
        } else if (buyPrice < 100) {
            minProfitMargin = 0.012; // 1.2% for medium, fast-moving items
        } else {
            minProfitMargin = 0.015; // 1.5% for expensive, fast-moving items
        }
    }
    // Medium velocity items (2-7 sales/week) - Balanced approach
    else if (weeklyVolume >= 2) {
        velocityCategory = 'MEDIUM_VELOCITY';
        if (buyPrice < 50) {
            minProfitMargin = 0.020; // 2.0% for small, medium velocity items
        } else if (buyPrice < 200) {
            minProfitMargin = 0.025; // 2.5% for medium, medium velocity items
        } else {
            minProfitMargin = 0.020; // 2.0% for expensive, medium velocity items
        }
    }
    // Low velocity items (<2 sales/week) - Higher margins needed to justify holding time
    else {
        velocityCategory = 'LOW_VELOCITY';
        if (buyPrice < 30) {
            minProfitMargin = 0.035; // 3.5% for small, slow-moving items
        } else if (buyPrice < 150) {
            minProfitMargin = 0.045; // 4.5% for medium, slow-moving items
        } else {
            minProfitMargin = 0.030; // 3.0% for expensive, slow-moving items
        }
    }
    
    // Calculate minimum profitable price with realistic margins
    const minProfitablePrice = buyPrice * (1 + minProfitMargin) / (1 - SKINPORT_FEE);
    
    // Only apply minimum profit as final safety check, not primary driver
    if (basePrice < minProfitablePrice) {
        const adjustedPrice = minProfitablePrice;
        
        // But still respect RECENT market reality - if even minimum profit exceeds recent tolerance, reject
        if (adjustedPrice > recentMarketTolerance) {
            console.log(`[Recent Market Reality] ${buyPrice.toFixed(2)} item: Even minimum profit €${adjustedPrice.toFixed(2)} exceeds recent market tolerance €${recentMarketTolerance.toFixed(2)} - REJECTING`);
            return {
                achievablePrice: 0, // Signal rejection
                confidence: 'REJECTED',
                strategy: 'PROFIT_IMPOSSIBLE',
                reasoning: `Even ${(minProfitMargin*100).toFixed(1)}% margin (€${adjustedPrice.toFixed(2)}) exceeds recent market reality [${velocityCategory}: ${weeklyVolume} sales/week]`
            };
        }
        
        basePrice = adjustedPrice;
        reasoning += `, adjusted to minimum ${(minProfitMargin*100).toFixed(1)}% margin (€${(minProfitMargin*buyPrice).toFixed(2)} profit) [${velocityCategory}: ${weeklyVolume} sales/week]`;
    }
    
    // Ensure we don't price way above what actually sells
    if (basePrice > salesMax) {
        basePrice = salesMax * 0.95;
        reasoning += ', capped at max sales price';
    }
    
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
 * Enhanced confidence calculation with stability and color-coding support
 */
function calculateOverallConfidence(marketData, multiTimeframeData, smartPricing, salesVolume, currentQuantity) {
    let score = 0;
    const factors = [];
    
    // Recent data quality (35% of confidence) - Recent timeframes are more important
    const recentDataQuality = multiTimeframeData.recentDataQuality;
    const bestPeriod = multiTimeframeData.bestTimeframe.period;
    
    if (recentDataQuality === 'EXCELLENT' && salesVolume >= 8) {
        score += 35;
        factors.push('Excellent recent data (24h, 8+ sales)');
    } else if (recentDataQuality === 'EXCELLENT' && salesVolume >= 3) {
        score += 32;
        factors.push('Excellent recent data (24h, 3+ sales)');
    } else if (recentDataQuality === 'GOOD' && salesVolume >= 5) {
        score += 30;
        factors.push('Good recent data (7d, 5+ sales)');
    } else if (recentDataQuality === 'GOOD' && salesVolume >= 2) {
        score += 25;
        factors.push('Good recent data (7d, 2+ sales)');
    } else if (bestPeriod === '30d' && salesVolume >= 10) {
        score += 20;
        factors.push('Monthly data fallback (10+ sales)');
    } else if (salesVolume >= 1) {
        score += 15;
        factors.push('Limited recent data');
    } else {
        score += 8;
        factors.push('Very limited data');
    }
    
    // Market stability (25% of confidence) - Price volatility check
    const currentMinPrice = marketData.min_price;
    const currentMaxPrice = marketData.max_price;
    const currentMeanPrice = marketData.mean_price;
    const priceSpread = ((currentMaxPrice - currentMinPrice) / currentMeanPrice) * 100;
    
    if (priceSpread <= 10) {
        score += 25;
        factors.push('Very stable pricing (<10% spread)');
    } else if (priceSpread <= 20) {
        score += 20;
        factors.push('Stable pricing (10-20% spread)');
    } else if (priceSpread <= 35) {
        score += 15;
        factors.push('Moderate volatility (20-35% spread)');
    } else if (priceSpread <= 50) {
        score += 10;
        factors.push('High volatility (35-50% spread)');
    } else {
        score += 5;
        factors.push('Very high volatility (>50% spread)');
    }
    
    // Market liquidity (25% of confidence) - Competition and volume
    if (currentQuantity >= 5 && currentQuantity <= 25 && salesVolume >= 5) {
        score += 25;
        factors.push('Excellent liquidity (5-25 listings, 5+ sales)');
    } else if (currentQuantity >= 2 && currentQuantity <= 35 && salesVolume >= 3) {
        score += 20;
        factors.push('Good liquidity (2-35 listings, 3+ sales)');
    } else if (currentQuantity >= 1 && salesVolume >= 2) {
        score += 15;
        factors.push('Moderate liquidity');
    } else if (currentQuantity >= 1) {
        score += 10;
        factors.push('Limited liquidity');
    } else {
        score += 5;
        factors.push('Poor liquidity');
    }
    
    // Pricing strategy confidence (15% of confidence)
    if (smartPricing.strategy === 'SALES_BASED' && smartPricing.confidence === 'HIGH') {
        score += 15;
        factors.push('High-confidence sales-based pricing');
    } else if (smartPricing.strategy === 'HYBRID' && smartPricing.confidence !== 'VERY_LOW') {
        score += 12;
        factors.push('Balanced pricing strategy');
    } else if (smartPricing.confidence !== 'VERY_LOW') {
        score += 8;
        factors.push('Reasonable pricing confidence');
    } else {
        score += 5;
        factors.push('Limited pricing confidence');
    }
    
    // Determine confidence level with color coding
    let confidenceLevel, colorCode, stabilityRating;
    
    if (score >= 70 && priceSpread <= 20) {
        confidenceLevel = 'HIGH';
        colorCode = 'GREEN'; // Safe, stable, profitable
        stabilityRating = 'STABLE';
    } else if (score >= 50 && priceSpread <= 35) {
        confidenceLevel = 'MEDIUM';
        colorCode = 'ORANGE'; // Proceed with caution
        stabilityRating = priceSpread <= 25 ? 'MODERATE' : 'VOLATILE';
    } else {
        confidenceLevel = 'LOW';
        colorCode = 'RED'; // High risk, avoid or be very careful
        stabilityRating = priceSpread > 50 ? 'VERY_VOLATILE' : 'UNSTABLE';
    }
    
    return {
        level: confidenceLevel,
        score: Math.round(score),
        factors,
        colorCode,
        stabilityRating,
        marketMetrics: {
            priceSpread: priceSpread.toFixed(1),
            recentDataQuality,
            dataTimeframe: bestPeriod
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
                console.log(`[Backend] No usable sales history for: ${itemName}`);
                continue;
            }
            
            const priceData = multiTimeframeAnalysis.bestTimeframe.data;
            const timeframePeriod = multiTimeframeAnalysis.bestTimeframe.period;
            
            console.log(`[Multi-Timeframe] ${itemName}: Using ${timeframePeriod} data (${priceData.volume} sales, trend: ${multiTimeframeAnalysis.trend})`);
            
            // SMART ACHIEVABLE PRICE: Use actual sales data for realistic pricing
            const skinportBuyPrice = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            
            // Float Value Intelligence Analysis
            const floatAnalysis = analyzeFloatValue(normalizedName, skinportBuyPrice);
            console.log(`[Float Intelligence] ${normalizedName}: ${floatAnalysis.floatAnalysis}`);
            
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
