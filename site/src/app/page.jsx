export default function IndexPage() {
  return (
    <div style={{ textAlign: 'center', padding: '100px 20px' }}>
      <h1 style={{ fontSize: 48, fontWeight: 'bold', marginBottom: 16 }}>
        Mincho.js
      </h1>
      <p style={{ fontSize: 20, color: '#666', marginBottom: 32 }}>
        Natural CSS in TypeScript
      </p>
      <a
        href="/docs"
        style={{
          display: 'inline-block',
          padding: '12px 24px',
          backgroundColor: '#0070f3',
          color: 'white',
          borderRadius: 8,
          textDecoration: 'none',
          fontWeight: 500
        }}
      >
        Get Started
      </a>
    </div>
  )
}
