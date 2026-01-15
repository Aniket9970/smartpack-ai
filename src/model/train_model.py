import numpy as np
import pandas as pd
import json

def train():
    try:
        df = pd.read_csv('src/model/dataset.csv')
    except FileNotFoundError:
        print("Dataset not found.")
        return

    # Features: [Bias(1), w, h, d, weight, fragility]
    X = df[['w', 'h', 'd', 'weight', 'fragility']].values
    X_b = np.c_[np.ones((len(X), 1)), X]
    
    # Target: [target_w, target_h, target_d, thickness]
    y = df[['target_w', 'target_h', 'target_d', 'thickness']].values

    # Solve using Normal Equation
    theta = np.linalg.inv(X_b.T.dot(X_b)).dot(X_b.T).dot(y)

    print("\nModel Trained Successfully")
    
    # Export for JS
    with open('src/model/weights.json', 'w') as f:
        json.dump(theta.tolist(), f)
    
    # Save as .npy as well
    np.save('src/model/weights.npy', theta)

if __name__ == "__main__":
    train()
