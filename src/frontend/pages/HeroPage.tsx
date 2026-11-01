import { useRouter } from '../router.tsx';

export function HeroPage() {
  const { navigate } = useRouter();

  return (
    <div className="hero-page">
      <div className="hero-content">
        <h1 className="hero-title">TaskAside</h1>
        <p className="hero-subtitle">
          A local-first task queue and conversation UI for your coding agents.
        </p>
        <button
          type="button"
          className="btn btn-primary hero-cta"
          onClick={() => navigate('/app/workspace')}
        >
          Open Workspace
        </button>
      </div>
    </div>
  );
}
