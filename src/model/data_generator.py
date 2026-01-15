import pandas as pd
import numpy as np

def generate_dataset(n_samples=2000):
    np.random.seed(42)
    
    # Random product dimensions (cm)
    w = np.random.uniform(5, 60, n_samples)
    h = np.random.uniform(5, 60, n_samples)
    d = np.random.uniform(5, 60, n_samples)
    weight = np.random.uniform(0.5, 50, n_samples)
    
    # Fragility: 0 (Low), 1 (Med), 2 (High), 3 (Extreme)
    fragility = np.random.randint(0, 4, n_samples)
    
    # 22kg Fragile Bottle special case injection
    # Injecting specifically requested edge cases
    w[0], h[0], d[0], weight[0], fragility[0] = 15, 40, 15, 22.0, 2 # 22kg Glass Bottle
    
    # Clearance formula: baseline 2cm + fragility boost + weight boost
    # More aggressive for heavy/fragile items
    clearance = 1.5 + (fragility * 2.0) + (weight * 0.12)
    
    # Targets
    box_w = w + (clearance * 2)
    box_h = h + (clearance * 2)
    box_d = d + (clearance * 2)
    
    # Thickness level 1-7
    # Thresholds: level = weight/7 + fragility/2
    thickness = 1 + (weight / 6) + (fragility / 1.5)
    thickness = np.clip(np.round(thickness), 1, 7).astype(int)
    
    df = pd.DataFrame({
        'w': w, 'h': h, 'd': d, 
        'weight': weight, 
        'fragility': fragility,
        'target_w': box_w, 'target_h': box_h, 'target_d': box_d,
        'thickness': thickness
    })
    
    df.to_csv('src/model/dataset.csv', index=False)
    print(f"Dataset generated: {len(df)} samples")

if __name__ == "__main__":
    generate_dataset()
