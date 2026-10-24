import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import './index.css'
import { installViewAsGuard } from './services/viewAs'

// View As: в режиме просмотра браузер не выпускает действий наружу (до первого запроса приложения).
installViewAsGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
