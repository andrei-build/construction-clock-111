import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Временный хостинг через Supabase edge-функцию: base + внешние библиотеки с CDN (маленький бандл)
const CDN = {
  react: 'https://esm.sh/react@18.3.1',
  'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
  'react-dom': 'https://esm.sh/react-dom@18.3.1?deps=react@18.3.1',
  'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1',
  'react-router-dom': 'https://esm.sh/react-router-dom@6.26.0?deps=react@18.3.1,react-dom@18.3.1',
  '@supabase/supabase-js': 'https://esm.sh/@supabase/supabase-js@2.45.0',
}

export default defineConfig({
  plugins: [react()],
})
