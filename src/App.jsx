import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom'
import { Canvas } from '@react-three/fiber'
import { Edges, Html, OrbitControls } from '@react-three/drei'
import { DoubleSide } from 'three'
import { ClerkProvider, SignInButton, SignUpButton, useUser, useClerk } from '@clerk/clerk-react'
import { supabase } from './supabaseClient'
import { predictPackaging, saveFeedback } from './model/smartModel'
const FRAGILITY_LEVELS = {
  LOW: { label: 'Low' },
  MEDIUM: { label: 'Medium' },
  HIGH: { label: 'High' },
  EXTREME: { label: 'Extreme' }
}

const clamp = (value) => Math.max(0.1, Number(value) || 0)
const round1 = (value) => Math.round(value * 10) / 10

const mapReportRow = (row) => ({
  id: row.id || row.title || 'Report',
  title: row.title || 'Saved report',
  packaging: row.packaging || 'N/A',
  dims: row.dims || 'N/A',
  utilization: row.utilization || 'N/A',
  voidSpace: row.void_space || row.voidSpace || 'N/A',
  date: row.created_at ? new Date(row.created_at).toLocaleDateString() : row.date || '—',
  aiNote: row.ai_note || row.aiNote || '—',
  reportText: row.report_text
})

const buildReportPayload = (product, packagingType, recommendation, spaceMessage, costInfo) => {
  const box = recommendation.box
  const lines = [
    'SmartPack AI Packaging Report',
    `Product: ${product.name || 'Unnamed product'}`,
    `Brand: ${product.brand || 'N/A'}`,
    `Packaging type: ${packagingType}`,
    `Recommended box: ${box.width} × ${box.depth} × ${box.height} (W×D×H)`,
    `Utilization: ${recommendation.utilization}%`,
    `Void: ${recommendation.voidPercent}% (~${recommendation.voidSpace}³ units)`,
    `Safety rating: ${recommendation.safetyRating}`,
    `ML thickness: ${recommendation.thickness.type} (Lvl ${recommendation.thickness.level})`,
    `Recommended fill: ${recommendation.recommendedFill}`,
    `AI suggestion: ${spaceMessage}`,
    costInfo ? `Estimated cost with AI: ₹${costInfo.aiCost} • Baseline: ₹${costInfo.baselineCost} • Savings: ₹${costInfo.savings}` : null
  ].filter(Boolean)
  return {
    title: product.name || 'Packaging report',
    packaging: packagingType,
    dims: `${box.width} × ${box.depth} × ${box.height} (W×D×H)`,
    utilization: `${recommendation.utilization}%`,
    voidSpace: `${recommendation.voidPercent}% (~${recommendation.voidSpace}³ units)`,
    aiNote: spaceMessage,
    reportText: lines.join('\n')
  }
}

const MATERIAL_RATES = {
  corrugatedThin: { min: 15, max: 20 },
  duplexStandard: { min: 40, max: 50 },
  duplexThick: { min: 50, max: 80 },
  kraftCorrugated: { min: 20, max: 35 }
}
const MATERIAL_GSM = {
  corrugatedThin: { min: 150, max: 150 },
  duplexStandard: { min: 200, max: 330 },
  duplexThick: { min: 400, max: 450 },
  kraftCorrugated: { min: 100, max: 200 }
}
const averageRange = (range) => round1((range.min + range.max) / 2)
const getMaterialProfile = (packagingType, thicknessLevel = 1) => {
  const level = thicknessLevel || 1
  if (packagingType === 'Mailer' || packagingType === 'Envelope') {
    if (level >= 5) return { rate: averageRange(MATERIAL_RATES.duplexThick), gsm: averageRange(MATERIAL_GSM.duplexThick) }
    return { rate: averageRange(MATERIAL_RATES.duplexStandard), gsm: averageRange(MATERIAL_GSM.duplexStandard) }
  }
  if (level <= 2) return { rate: averageRange(MATERIAL_RATES.corrugatedThin), gsm: averageRange(MATERIAL_GSM.corrugatedThin) }
  if (level <= 4) return { rate: averageRange(MATERIAL_RATES.kraftCorrugated), gsm: averageRange(MATERIAL_GSM.kraftCorrugated) }
  if (level === 5) return { rate: averageRange(MATERIAL_RATES.duplexStandard), gsm: averageRange(MATERIAL_GSM.duplexStandard) }
  return { rate: averageRange(MATERIAL_RATES.duplexThick), gsm: averageRange(MATERIAL_GSM.duplexThick) }
}
const computeBoardWeightG = (box, gsm) => {
  const w = Number(box.width) || 0
  const h = Number(box.height) || 0
  const d = Number(box.depth) || 0
  const areaCm2 = 2 * (w * h + w * d + h * d)
  const areaM2 = areaCm2 / 10000
  const scrapFactor = 1.08
  return round1(areaM2 * gsm * scrapFactor)
}
const estimateCost = (box, packagingType, thicknessLevel = 1, voidSpace = 0) => {
  const profile = getMaterialProfile(packagingType, thicknessLevel)
  const boardWeightG = computeBoardWeightG(box, profile.gsm)
  const materialCost = round1((boardWeightG / 1000) * profile.rate)
  const fillerDensityGPerCm3 = 0.002
  const fillerRatePerKg = 80
  const fillerWeightG = round1(Math.max(0, voidSpace) * fillerDensityGPerCm3)
  const fillerCost = round1((fillerWeightG / 1000) * fillerRatePerKg)
  const total = round1(materialCost + fillerCost)
  return { materialCost, fillerCost, total, boardWeightG, fillerWeightG }
}

const saveReportToSupabase = async (userInfo, payload) => {
  if (!supabase || !userInfo?.email) return null
  const { data, error } = await supabase
    .from('reports')
    .insert({
      user_email: userInfo.email,
      title: payload.title,
      packaging: payload.packaging,
      dims: payload.dims,
      utilization: payload.utilization,
      void_space: payload.voidSpace,
      ai_note: payload.aiNote,
      report_text: payload.reportText
    })
    .select()
    .single()
  if (error) return null
  return mapReportRow(data)
}

const deletedKey = (email) => `deleted_reports_${email}`
const getDeletedIds = (email) => {
  if (!email) return new Set()
  try {
    const raw = localStorage.getItem(deletedKey(email))
    const arr = raw ? JSON.parse(raw) : []
    return new Set(arr.map(String))
  } catch (e) {
    return new Set()
  }
}
const rememberDeleted = (email, id) => {
  if (!email || !id) return
  const set = getDeletedIds(email)
  set.add(String(id))
  localStorage.setItem(deletedKey(email), JSON.stringify(Array.from(set)))
}

const fetchReportsFromSupabase = async (userInfo) => {
  if (!supabase || !userInfo?.email) return []
  const deletedSet = getDeletedIds(userInfo.email)
  const { data, error } = await supabase
    .from('reports')
    .select('id, title, packaging, dims, utilization, void_space, ai_note, created_at, report_text')
    .eq('user_email', userInfo.email)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error || !data) return []
  return data.map(mapReportRow).filter((row) => !deletedSet.has(String(row.id)))
}

const deleteReportFromSupabase = async (userInfo, id) => {
  if (!supabase || !userInfo?.email || !id) return false
  const { error } = await supabase
    .from('reports')
    .delete()
    .eq('user_email', userInfo.email)
    .eq('id', id)
  rememberDeleted(userInfo.email, id)
  if (error) return false
  return true
}

const Input = ({ label, value, onChange, placeholder, step = 0.1 }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    <input
      className="input"
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(clamp(e.target.value))}
      placeholder={placeholder}
    />
  </label>
)

const TextInput = ({ label, value, onChange, placeholder }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
  </label>
)

const Select = ({ label, value, onChange, options }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  </label>
)

const Legend = () => (
  <div className="legend">
    <span className="legend-item"><span className="swatch" style={{ background: 'linear-gradient(135deg, #8b5cf6, #a78bfa)' }} />AI Box</span>
    <span className="legend-item"><span className="swatch" style={{ background: 'linear-gradient(135deg, #10b981, #34d399)' }} />Product</span>
  </div>
)

const DimensionLabel = ({ position, text, color }) => (
  <Html position={position} center>
    <div
      style={{
        padding: '6px 10px',
        borderRadius: '10px',
        background: 'rgba(255,255,255,0.9)',
        border: `1px solid ${color}`,
        color: '#0f172a',
        fontSize: 12,
        fontWeight: 700,
        boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
        whiteSpace: 'nowrap'
      }}
    >
      {text}
    </div>
  </Html>
)

const DimensionSet = ({ size, color, prefix, offsetScale = 0.12 }) => {
  const [w, h, d] = size
  const offset = Math.max(w, h, d, 1) * offsetScale
  return (
    <>
      <DimensionLabel position={[0, h / 2 + offset * 0.4, d / 2 + offset]} text={`${prefix} W ${w}`} color={color} />
      <DimensionLabel position={[w / 2 + offset, h / 2 + offset * 0.4, 0]} text={`${prefix} D ${d}`} color={color} />
      <DimensionLabel position={[w / 2 + offset, 0, d / 2 + offset]} text={`${prefix} H ${h}`} color={color} />
    </>
  )
}

const Scene = ({ product, box, showLogoPreview }) => {
  const { maxDimension, cameraDistance, productSize, boxSize } = useMemo(() => {
    const maxDimension = Math.max(box.width, box.height, box.depth, product.width, product.height, product.depth, 1)
    const cameraDistance = maxDimension * 1.9
    return {
      maxDimension,
      cameraDistance,
      productSize: [product.width, product.height, product.depth],
      boxSize: [box.width, box.height, box.depth]
    }
  }, [box.depth, box.height, box.width, product.depth, product.height, product.width])
  const brandLabel = product.brand || 'Brand'
  const productLabel = product.name || 'Product'

  return (
    <Canvas camera={{ position: [cameraDistance, cameraDistance, cameraDistance], fov: 40 }} shadows>
      <color attach="background" args={['#0f172a']} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[maxDimension, maxDimension * 1.3, maxDimension]} intensity={1.2} castShadow />
      <pointLight position={[-maxDimension, maxDimension, -maxDimension]} intensity={0.3} color="#8b5cf6" />
      <gridHelper args={[maxDimension * 3, 16]} position={[0, -maxDimension / 2, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -maxDimension / 2, 0]} receiveShadow>
        <planeGeometry args={[maxDimension * 3, maxDimension * 3]} />
        <meshStandardMaterial color="#1e293b" metalness={0.1} roughness={0.8} />
      </mesh>
      <group>
        <mesh position={[0, 0, 0]} receiveShadow>
          <boxGeometry args={boxSize} />
          <meshPhysicalMaterial color="#8b5cf6" transparent opacity={0.25} roughness={0.3} metalness={0.1} clearcoat={0.3} />
          <Edges color="#a78bfa" linewidth={2} />
        </mesh>
        {showLogoPreview && (
          <group position={[0, boxSize[1] / 2 + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <mesh>
              <planeGeometry args={[boxSize[0], boxSize[2]]} />
              <meshStandardMaterial
                color="#a78bfa"
                transparent
                opacity={0.22}
                roughness={0.2}
                metalness={0.05}
                side={DoubleSide}
              />
            </mesh>
            <Html center transform position={[0, 0, 0.01]}>
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: '10px',
                  background: 'rgba(15,23,42,0.7)',
                  border: '1px solid rgba(167,139,250,0.45)',
                  color: '#f8fafc',
                  textAlign: 'center',
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  minWidth: '140px'
                }}
              >
                <div>{brandLabel}</div>
                <div style={{ fontSize: '12px', opacity: 0.9 }}>{productLabel}</div>
              </div>
            </Html>
          </group>
        )}
        <mesh position={[0, 0, 0]} castShadow receiveShadow>
          <boxGeometry args={productSize} />
          <meshStandardMaterial color="#10b981" transparent opacity={0.75} roughness={0.25} metalness={0.1} />
          <Edges color="#34d399" linewidth={2} />
        </mesh>
      </group>
      <DimensionSet size={boxSize} color="#a78bfa" prefix="Box" />
      <DimensionSet size={productSize} color="#34d399" prefix="Product" offsetScale={0.08} />
      <OrbitControls enablePan enableZoom enableRotate makeDefault />
    </Canvas>
  )
}

const packagingTargets = {
  Box: { utilization: 0.87, clearance: 1.8 },
  Mailer: { utilization: 0.82, clearance: 1.2 },
  Envelope: { utilization: 0.78, clearance: 0.8 },
  Tube: { utilization: 0.8, clearance: 1.5 }
}

const productTypes = ['Plastic', 'Glass', 'Metal', 'Paper', 'Wood', 'Composite']

const recommendBox = (product, packagingType, productType) => {
  const safeProduct = {
    ...product,
    width: Number(product.width) || 0,
    height: Number(product.height) || 0,
    depth: Number(product.depth) || 0,
    weight: Number(product.weight) || 0
  }
  const prediction = predictPackaging(safeProduct, packagingType)
  const minClearance = productType === 'Paper' ? 0.5 : 1.2
  const adjustedBox = {
    width: round1(Math.max(prediction.dimensions.width, safeProduct.width + minClearance)),
    height: round1(Math.max(prediction.dimensions.height, safeProduct.height + minClearance)),
    depth: round1(Math.max(prediction.dimensions.depth, safeProduct.depth + minClearance))
  }
  const productVolume = safeProduct.width * safeProduct.height * safeProduct.depth
  const boxVolume = adjustedBox.width * adjustedBox.height * adjustedBox.depth
  const utilization = productVolume > 0 ? round1((productVolume / boxVolume) * 100) : 0
  return {
    box: adjustedBox,
    utilization,
    voidPercent: round1(100 - utilization),
    voidSpace: round1(boxVolume - productVolume),
    recommendedFill: prediction.recommendedFill,
    thickness: prediction.thickness,
    safetyRating: prediction.safetyRating
  }
}

const Stepper = ({ active = 1 }) => {
  const steps = [
    { label: 'Product Info', path: '/product' },
    { label: 'Sustainability', path: '/sustainability' },
    { label: 'Optimization', path: '/optimization' },
    { label: 'Results', path: '/results' }
  ]
  return (
    <div className="stepper">
      {steps.map((step, idx) => {
        const number = idx + 1
        const state = number < active ? 'done' : number === active ? 'active' : 'idle'
        return (
          <Link key={step.label} to={step.path} className={`step ${state}`}>
            <span className="step-number">{number}</span>
            <span className="step-label">{step.label}</span>
          </Link>
        )
      })}
    </div>
  )
}

const Topbar = ({ user, onLogout }) => {
  const initials = ((user?.name || user?.email || 'SP').match(/\b\w/g) || []).join('').slice(0, 2).toUpperCase()
  const avatarStyle = user?.avatar
    ? { backgroundImage: `url(${user.avatar})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'transparent' }
    : {}
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">SP</div>
        <span className="brand-name">SmartPack AI</span>
      </div>
      <div className="topbar-actions">
        {user && <Link to="/product" className="ghost">Go to App</Link>}
        {user && <Link to="/dashboard" className="ghost">Dashboard</Link>}
        {user ? (
          <button className="ghost" onClick={onLogout}>Logout</button>
        ) : (
          <>
            <Link to="/login" className="ghost">Login</Link>
            <Link to="/signup" className="ghost">Sign Up</Link>
          </>
        )}
        <div className="user-logo" title={user ? `${user.name} • ${user.role}` : 'Login to access history'} style={avatarStyle}>
          {!user?.avatar && initials}
        </div>
      </div>
    </header>
  )
}

const StageLayout = ({ active, children, user, onLogout, showStepper = true }) => (
  <div className="page">
    <Topbar user={user} onLogout={onLogout} />
    {showStepper && <Stepper active={active} />}
    {children}
  </div>
)

const DashboardPage = ({ user, onLogout }) => {
  const [reports, setReports] = useState([])

  useEffect(() => {
    let active = true
    const loadReports = async () => {
      const rows = await fetchReportsFromSupabase(user)
      if (active) setReports(rows)
    }
    loadReports()
    return () => {
      active = false
    }
  }, [user])

  const handleDelete = async (id) => {
    const ok = await deleteReportFromSupabase(user, id)
    if (ok) setReports((prev) => prev.filter((r) => r.id !== id))
  }

  const downloadHistoryReport = (record) => {
    const content =
      record.reportText ||
      [
        `SmartPack AI Worklog • ${record.id}`,
        `Product: ${record.title}`,
        `Packaging type: ${record.packaging}`,
        `Dimensions: ${record.dims}`,
        `Utilization: ${record.utilization}`,
        `Void: ${record.voidSpace}`,
        `AI suggestion: ${record.aiNote}`
      ].join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${record.id || 'report'}-smartpack-report.txt`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <StageLayout showStepper={false} user={user} onLogout={onLogout}>
      <section className="dashboard-hero">
        <h2>{user ? `Welcome back, ${user.name}` : 'Login required'}</h2>
        <p>Review previous production info, dimension predictions, and AI suggestions. Download reports instantly for your reference.</p>
      </section>
      <div className="dashboard-grid">
        {reports.length === 0 && <div className="card">No reports yet.</div>}
        {reports.map((record) => (
          <div className="history-card" key={record.id}>
            <button className="history-delete" type="button" onClick={() => handleDelete(record.id)} aria-label="Delete report">
              ×
            </button>
            <div className="history-row">
              <span className="history-id">{record.id}</span>
              <span className="history-date">{record.date}</span>
            </div>
            <h3>{record.title}</h3>
            <ul className="history-metadata">
              <li>Packaging type: {record.packaging}</li>
              <li>Dimensions: {record.dims}</li>
              <li>Utilization: {record.utilization}</li>
              <li>Void: {record.voidSpace}</li>
            </ul>
            <p className="history-note">AI note: {record.aiNote}</p>
            <div className="history-actions">
              <button type="button" className="ghost" onClick={() => downloadHistoryReport(record)}>
                Download report
              </button>
            </div>
          </div>
        ))}
      </div>
    </StageLayout>
  )
}

const LoginPage = ({ user }) => {
  const navigate = useNavigate()
  const clerkKeyLoaded = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)

  useEffect(() => {
    if (user) navigate('/product', { replace: true })
  }, [user, navigate])

  return (
    <div className="page">
      <Topbar user={user} />
      <div className="card form-card" style={{ maxWidth: 520, margin: '40px auto' }}>
        <h2>Login</h2>
        <SignInButton mode="redirect" redirectUrl="/product" afterSignInUrl="/product">
          <button className="primary" style={{ marginTop: 8, width: '100%' }}>
            Continue with Clerk
          </button>
        </SignInButton>
        <p className="login-hint" style={{ marginTop: 12 }}>
          {clerkKeyLoaded
            ? 'Clerk key loaded. Sign in to continue.'
            : 'Set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk authentication.'}
        </p>
        <p className="login-hint">No account? <Link to="/signup">Sign up</Link></p>
      </div>
    </div>
  )
}

const SignUpPage = ({ user }) => {
  const navigate = useNavigate()

  useEffect(() => {
    if (user) navigate('/product', { replace: true })
  }, [user, navigate])

  return (
    <div className="page">
      <Topbar user={user} />
      <div className="card form-card" style={{ maxWidth: 520, margin: '40px auto' }}>
        <h2>Create your account</h2>
        <SignUpButton mode="redirect" redirectUrl="/product" afterSignUpUrl="/product">
          <button className="primary" style={{ marginTop: 8, width: '100%' }}>
            Sign up with Clerk
          </button>
        </SignUpButton>
        <p className="login-hint" style={{ marginTop: 12 }}>Already have an account? <Link to="/login">Login</Link></p>
      </div>
    </div>
  )
}

const ProductPage = ({ product, setProduct, category, setCategory, packagingType, setPackagingType, user, onLogout }) => {
  const packagingOptions = ['Box', 'Mailer', 'Envelope', 'Tube']
  return (
    <StageLayout active={1} user={user} onLogout={onLogout}>
      <div className="grid">
        <div className="card form-card">
          <h2>Your packaging design information</h2>
          <div className="form-grid">
            <TextInput label="Product" value={product.name || ''} onChange={(v) => setProduct((p) => ({ ...p, name: v }))} placeholder="Enter product name" />
            <TextInput label="Brand" value={product.brand || ''} onChange={(v) => setProduct((p) => ({ ...p, brand: v }))} placeholder="Enter brand" />
            <Input label="Width" placeholder="Width (cm)" value={product.width} onChange={(v) => setProduct((p) => ({ ...p, width: v }))} />
            <Input label="Depth" placeholder="Depth (cm)" value={product.depth} onChange={(v) => setProduct((p) => ({ ...p, depth: v }))} />
            <Input label="Height" placeholder="Height (cm)" value={product.height} onChange={(v) => setProduct((p) => ({ ...p, height: v }))} />
            <Input label="Weight (kg)" placeholder="Weight (kg)" step={0.1} value={product.weight} onChange={(v) => setProduct((p) => ({ ...p, weight: v }))} />
            <Select label="Product type" value={category} onChange={setCategory} options={productTypes} />
            <Select 
              label="Fragility" 
              value={product.fragility} 
              onChange={(v) => setProduct((p) => ({ ...p, fragility: v }))} 
              options={Object.keys(FRAGILITY_LEVELS)} 
            />
            <label className="field">
              <span className="field-label">Packaging type</span>
              <div className="type-row">
                {packagingOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`type-chip ${opt === packagingType ? 'active' : ''}`}
                    onClick={() => setPackagingType(opt)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </label>
          </div>
          <div className="hint-row">
            <div className="hint">Accurate dimensions ensure better recommendations.</div>
            <Link className="primary" to="/sustainability">Continue to Sustainability</Link>
          </div>
        </div>

        <div className="card tips">
          <div className="badge">Welcome to SmartPack AI</div>
          <h3>Quick tips</h3>
          <ul>
            <li>Accurate dimensions ensure better recommendations.</li>
            <li>{category} typically uses reinforced fluting.</li>
            <li>Average savings 15–30% with optimized void.</li>
          </ul>
        </div>
      </div>
    </StageLayout>
  )
}

const SustainabilityPage = ({ sustainability, setSustainability, user, onLogout }) => {
  const options = [
    { key: 'Max Sustainability', sub: '-40% CO₂', color: '#16a34a' },
    { key: 'Balanced', sub: '-25% CO₂', color: '#2563eb' },
    { key: 'Cost Optimized', sub: '-15% CO₂', color: '#d97706' }
  ]
  return (
    <StageLayout active={2} user={user} onLogout={onLogout}>
      <div className="grid two">
        <div className="card">
          <h2>Sustainability & Material Selection</h2>
          <div className="type-row" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            {options.map((opt) => (
              <button
                key={opt.key}
                className={`type-chip ${sustainability === opt.key ? 'active' : ''}`}
                onClick={() => setSustainability(opt.key)}
              >
                <div style={{ color: opt.color, fontWeight: 800 }}>{opt.key}</div>
                <div style={{ color: '#475569' }}>{opt.sub}</div>
              </button>
            ))}
          </div>
          <div className="void-grid" style={{ marginTop: 12 }}>
            <div className="void-card">
              <div className="void-label">Single-wall</div>
              <div className="void-value">₹0.80</div>
              <div className="void-sub">Up to 10kg</div>
            </div>
            <div className="void-card">
              <div className="void-label">Double-wall</div>
              <div className="void-value">₹1.45</div>
              <div className="void-sub">Up to 30kg</div>
            </div>
            <div className="void-card">
              <div className="void-label">Triple-wall</div>
              <div className="void-value">₹2.20</div>
              <div className="void-sub">Up to 30kg+</div>
            </div>
          </div>
          <div className="hint-row">
            <Link className="ghost" to="/product">Back</Link>
            <Link className="primary" to="/optimization">Continue to Optimization</Link>
          </div>
        </div>

        <div className="card result-card">
          <div className="card-header">
            <h3>SUSTAINABILITY</h3>
            <span className="badge">Recycled 60%</span>
          </div>
          <div className="result-body" style={{ justifyContent: 'center' }}>
            <div className="result-block">
              <div className="result-box after">RECOMMENDED</div>
              <span className="result-label">Material comparison</span>
            </div>
          </div>
        </div>
      </div>
    </StageLayout>
  )
}

const OptimizationPage = ({ product, packagingType, user, onLogout, category }) => {
  const recommendation = useMemo(() => recommendBox(product, packagingType, category), [product, packagingType, category])
  const box = recommendation.box
  const spaceMessage = recommendation.utilization >= 85 ? 'Optimal fit detected' : 'Tighten fit to reduce void'

  return (
    <StageLayout active={3} user={user} onLogout={onLogout}>
      <section className="hero">
        <div>
          <p className="eyebrow">Stage 3 → Optimization</p>
          <h1>AI packaging optimizer</h1>
          <p className="muted">SmartPack AI suggests the box, estimates void fill, and shows recommendations.</p>
          <div className="pills">
            <span className="pill">Space utilization target {packagingTargets[packagingType].utilization * 100}%</span>
            <span className="pill success">Void fill: {recommendation.recommendedFill}</span>
          </div>
        </div>
        <div className="hero-card">
          <div className="hero-stat">
            <span className="stat-label">AI Recommended Box</span>
            <strong className="stat-value">{box.width} × {box.depth} × {box.height}</strong>
            <span className="stat-sub">W × D × H</span>
          </div>
          <div className="hero-stat">
            <span className="stat-label">Utilization</span>
            <strong className="stat-value">{recommendation.utilization}%</strong>
            <span className="stat-sub">Void {recommendation.voidPercent}%</span>
          </div>
        </div>
      </section>

      <div className="grid two">
        <div className="card">
          <div className="card-header">
            <h2>AI recommended box size</h2>
            <span className="badge soft">Stage 3</span>
          </div>
          <div className="box-visual">
            <div className="bar" />
            <div className="dim-row">
              <span>{box.width} W</span>
              <span>{box.depth} D</span>
              <span>{box.height} H</span>
            </div>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${Math.min(100, recommendation.utilization)}%` }} />
            </div>
            <div className="meter-labels">
              <span>{recommendation.utilization}% space utilization</span>
              <span>{spaceMessage}</span>
            </div>
          </div>
          <div className="void-grid">
            <div className="void-card">
              <div className="void-label">Void space</div>
              <div className="void-value">{recommendation.voidPercent}%</div>
              <div className="void-sub">{recommendation.voidSpace}³ units</div>
            </div>
            <div className="void-card">
              <div className="void-label">Recommended fill</div>
              <div className="void-value">{recommendation.recommendedFill}</div>
              <div className="void-sub">Based on ML safety factors</div>
            </div>
            <div className="void-card">
              <div className="void-label">Safety & Thickness</div>
              <div className="void-value" style={{ fontSize: '14px' }}>{recommendation.thickness.type}</div>
              <div className="void-sub">{recommendation.safetyRating} Safety Grade</div>
            </div>
          </div>
          <div className="hint-row">
            <Link className="ghost" to="/sustainability">Back</Link>
            <Link className="primary" to="/results">Continue to Results</Link>
          </div>
        </div>

        <div className="card result-card">
          <div className="card-header">
            <h3>Before vs After</h3>
            <span className="badge">Void savings</span>
          </div>
          <div className="result-body">
            <div className="result-block">
              <div className="result-box before">45% void</div>
              <span className="result-label">Old</span>
            </div>
            <div className="arrow large">→</div>
            <div className="result-block">
              <div className="result-box after">{recommendation.voidPercent}%</div>
              <span className="result-label">AI fit</span>
            </div>
          </div>
        </div>
      </div>
    </StageLayout>
  )
}

const ResultsPage = ({ product, packagingType, user, onLogout, category }) => {
  const [savedReport, setSavedReport] = useState(null)
  const recommendation = useMemo(() => recommendBox(product, packagingType, category), [product, packagingType, category])
  const box = recommendation.box
  const [saved, setSaved] = useState(false)
  const [logoPreview, setLogoPreview] = useState(false)
  const spaceMessage = recommendation.utilization >= 85 ? 'Optimal fit detected' : 'Tighten fit to reduce void'

  const productVolume = (Number(product.width) || 0) * (Number(product.height) || 0) * (Number(product.depth) || 0)
  const baselineBox = {
    width: (Number(product.width) || 0) * 1.2,
    height: (Number(product.height) || 0) * 1.2,
    depth: (Number(product.depth) || 0) * 1.2
  }
  const aiCostBreakdown = estimateCost(box, packagingType, recommendation.thickness.level, recommendation.voidSpace)
  const baselineBoxVolume = baselineBox.width * baselineBox.height * baselineBox.depth
  const baselineVoid = baselineBoxVolume - productVolume
  const baselineCostBreakdown = estimateCost(baselineBox, packagingType, Math.min(7, (recommendation.thickness.level || 1) + 1), baselineVoid)
  const aiCost = aiCostBreakdown.total
  const baselineCost = baselineCostBreakdown.total
  const savings = round1(Math.max(0, baselineCost - aiCost))
  const costInfo = {
    aiCost,
    baselineCost,
    savings,
    boardWeightG: aiCostBreakdown.boardWeightG,
    fillerWeightG: aiCostBreakdown.fillerWeightG,
    materialCost: aiCostBreakdown.materialCost,
    fillerCost: aiCostBreakdown.fillerCost
  }

  const handleSave = async () => {
    saveFeedback(product, box, recommendation.thickness.level)
    const payload = buildReportPayload(product, packagingType, recommendation, spaceMessage, costInfo)
    const savedRow = await saveReportToSupabase(user, payload)
    setSavedReport(savedRow || null)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const downloadReport = () => {
    const payload = savedReport || buildReportPayload(product, packagingType, recommendation, spaceMessage, costInfo)
    const blob = new Blob([payload.reportText], { type: 'text/plain' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'smartpack-report.txt'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <StageLayout active={4} user={user} onLogout={onLogout}>
      <section className="results">
        <div className="card results-card">
          <div className="card-header">
            <div>
              <span className="badge soft">Stage 4 • Results</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <h2>3D preview & metrics</h2>
                <button 
                  className={`primary ${saved ? 'success' : ''}`} 
                  onClick={handleSave}
                  style={{ padding: '8px 16px', fontSize: '12px', minWidth: '140px' }}
                >
                  {saved ? '✓ Model Updated' : 'Confirm & Train Model'}
                </button>
                <button
                  className={`ghost ${logoPreview ? 'active' : ''}`}
                  onClick={() => setLogoPreview((v) => !v)}
                  style={{ padding: '8px 14px', fontSize: '12px', minWidth: '140px', borderColor: logoPreview ? '#a78bfa' : undefined, color: logoPreview ? '#a78bfa' : undefined }}
                >
                  {logoPreview ? 'Hide logo side' : 'Logo preview'}
                </button>
                <button
                  className="ghost"
                  onClick={downloadReport}
                  style={{ padding: '8px 16px', fontSize: '12px', minWidth: '140px' }}
                >
                  Download full report
                </button>
              </div>
            </div>
            <div className="metrics">
              <div>
                <div className="metric-label">Box size</div>
                <div className="metric-value">{box.width} × {box.depth} × {box.height}</div>
              </div>
              <div>
                <div className="metric-label">Utilization</div>
                <div className="metric-value">{recommendation.utilization}%</div>
              </div>
              <div>
                <div className="metric-label">Safety Rating</div>
                <div className="metric-value success" style={{ color: '#10b981' }}>{recommendation.safetyRating}</div>
              </div>
              <div>
                <div className="metric-label">ML Thickness</div>
                <div className="metric-value">{recommendation.thickness.type} (Lvl {recommendation.thickness.level})</div>
              </div>
              <div>
                <div className="metric-label">Cost with AI</div>
                <div className="metric-value">₹{aiCost}</div>
              </div>
              <div>
                <div className="metric-label">Baseline cost</div>
                <div className="metric-value">₹{baselineCost}</div>
              </div>
              <div>
                <div className="metric-label">Estimated savings</div>
                <div className="metric-value success" style={{ color: '#10b981' }}>₹{savings}</div>
              </div>
            </div>
          </div>
          <div className="preview">
            <Legend />
            <div className="canvas-wrapper">
              <Scene product={product} box={box} showLogoPreview={logoPreview} />
            </div>
          </div>
        </div>
      </section>
    </StageLayout>
  )
}

const RequireAuth = ({ user, children }) => {
  if (!user) return <Navigate to="/login" replace />
  return children
}

const AppRouter = () => {
  const [product, setProduct] = useState({ width: '', height: '', depth: '', weight: '', name: '', brand: '', fragility: 'LOW' })
  const [category, setCategory] = useState('Plastic')
  const [packagingType, setPackagingType] = useState('Box')
  const [sustainability, setSustainability] = useState('Balanced')
  const { isSignedIn, user: clerkUser } = useUser()
  const { signOut } = useClerk()

  const authedUser = isSignedIn
    ? {
        name: clerkUser?.fullName || clerkUser?.primaryEmailAddress?.emailAddress || 'Clerk User',
        role: 'clerk',
        email: clerkUser?.primaryEmailAddress?.emailAddress || '',
        avatar: clerkUser?.imageUrl || ''
      }
    : null

  const handleLogout = async () => {
    if (isSignedIn) {
      await signOut({ redirectUrl: '/login' })
    }
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage user={authedUser} />} />
      <Route path="/signup" element={<SignUpPage user={authedUser} />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth user={authedUser}>
            <DashboardPage user={authedUser} onLogout={handleLogout} />
          </RequireAuth>
        }
      />
      <Route
        path="/product"
        element={
          <RequireAuth user={authedUser}>
            <ProductPage
              product={product}
              setProduct={setProduct}
              category={category}
              setCategory={setCategory}
              packagingType={packagingType}
              setPackagingType={setPackagingType}
              user={authedUser}
              onLogout={handleLogout}
            />
          </RequireAuth>
        }
      />
      <Route
        path="/sustainability"
        element={
          <RequireAuth user={authedUser}>
            <SustainabilityPage sustainability={sustainability} setSustainability={setSustainability} user={authedUser} onLogout={handleLogout} />
          </RequireAuth>
        }
      />
      <Route
        path="/optimization"
        element={
          <RequireAuth user={authedUser}>
            <OptimizationPage product={product} packagingType={packagingType} user={authedUser} onLogout={handleLogout} category={category} />
          </RequireAuth>
        }
      />
      <Route
        path="/results"
        element={
          <RequireAuth user={authedUser}>
            <ResultsPage product={product} packagingType={packagingType} user={authedUser} onLogout={handleLogout} category={category} />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

function App() {
  return (
    <ClerkProvider publishableKey={clerkPublishableKey || ''}>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </ClerkProvider>
  )
}

export default App
