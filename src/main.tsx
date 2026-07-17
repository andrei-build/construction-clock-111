import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './lib/auth'
import { I18nProvider } from './lib/i18n'
import { initClientErrorReporting } from './lib/clientErrors'
import UpdateToast from './components/UpdateToast'
import './styles.css'

initClientErrorReporting()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <App />
        </BrowserRouter>
      </AuthProvider>
      {/* PWA-UPDATE-1: сторож свежести версии. Вне AuthProvider/Router — работает на любом экране
          (включая логин) и в установленной PWA; сам ничего не рендерит, пока не нужен тост. */}
      <UpdateToast />
    </I18nProvider>
  </React.StrictMode>,
)
