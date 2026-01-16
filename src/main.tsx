import './index.css'
import App from './App.tsx'
import ControlsWindow from './components/ControlsWindow.tsx'

const isControls = window.location.hash === '#controls';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isControls ? <ControlsWindow /> : <App />}
  </StrictMode>,
)
