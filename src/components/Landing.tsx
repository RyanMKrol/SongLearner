import { login } from '../spotify/auth'

export function Landing({ error }: { error: string | null }) {
  return (
    <div className="landing">
      <div className="landing-card">
        <h1>
          Song<span className="accent">Learner</span>
        </h1>
        <p className="lede">Learn the words before karaoke night.</p>
        <ul className="landing-points">
          <li>Plays songs from your Spotify account, right in this tab</li>
          <li>Lyrics scroll in time with the music</li>
          <li>Loop a verse, chain sections together, then hide the words and test yourself</li>
        </ul>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-big" onClick={() => void login()}>
          Log in with Spotify
        </button>
        <p className="muted small">Needs Spotify Premium. Works best in Chrome, Edge or Firefox on a laptop.</p>
      </div>
    </div>
  )
}
