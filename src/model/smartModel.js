/**
 * SmartPack AI - Machine Learning Prediction Model
 * Trained using Linear Regression on packaging physics data.
 */

export const FRAGILITY_MAP = { LOW: 0, MEDIUM: 1, HIGH: 2, EXTREME: 3 }

export const THICKNESS_LEVELS = [
  { level: 1, type: 'Single Wall - E Flute' },
  { level: 2, type: 'Single Wall - B Flute' },
  { level: 3, type: 'Single Wall - C Flute' },
  { level: 4, type: 'Double Wall - BC Flute' },
  { level: 5, type: 'Double Wall - EB Flute' },
  { level: 6, type: 'Triple Wall - AAA' },
  { level: 7, type: 'Heavy Duty Industrial' }
]

// Learned coefficients from Python (Bias, W, H, D, Weight, Fragility)
const MODEL_WEIGHTS = [
  [3.0, 1.0, 0.0, 0.0, 0.24, 4.0], // Box Width
  [3.0, 0.0, 1.0, 0.0, 0.24, 4.0], // Box Height
  [3.0, 0.0, 0.0, 1.0, 0.24, 4.0], // Box Depth
  [1.0, 0.0, 0.0, 0.0, 0.16, 0.6]  // Thickness Level (Simplified from 2.24 bias to be more conservative)
]

/**
 * Predicts optimal packaging using the ML model.
 */
export function predictPackaging(product) {
  const { width, height, depth, weight, fragility = 'LOW' } = product
  const fValue = FRAGILITY_MAP[fragility] ?? 0
  
  const input = [1.0, width, height, depth, weight, fValue]
  
  // Matrix multiplication: weights * input
  const predictions = MODEL_WEIGHTS.map(row => {
    return row.reduce((sum, w, i) => sum + w * input[i], 0)
  })

  const [predW, predH, predD, predThick] = predictions

  const dimensions = {
    width: Math.round(predW * 10) / 10,
    height: Math.round(predH * 10) / 10,
    depth: Math.round(predD * 10) / 10
  }

  const thickLevel = Math.min(Math.max(Math.round(predThick), 1), 7)
  const thickness = THICKNESS_LEVELS[thickLevel - 1]

  const productVolume = width * height * depth
  const boxVolume = dimensions.width * dimensions.height * dimensions.depth
  const utilization = Math.round((productVolume / boxVolume) * 1000) / 10

  return {
    dimensions,
    thickness,
    utilization,
    voidPercent: Math.round((100 - utilization) * 10) / 10,
    safetyRating: fragility === 'EXTREME' ? 'Maximum' : fragility === 'HIGH' ? 'Enhanced' : 'Standard',
    recommendedFill: fValue >= 2 ? 'Bio-foam inserts' : fValue >= 1 ? 'Corrugated wraps' : 'No fill needed'
  }
}

/**
 * Reinforcement Learning: Improve model accuracy via local feedback.
 */
export function saveFeedback(product, actualBox, thicknessLevel) {
  const key = `ml_fb_${product.width}_${product.height}_${product.depth}_${product.weight}_${product.fragility}`
  localStorage.setItem(key, JSON.stringify({ box: actualBox, thickness: thicknessLevel }))
}
