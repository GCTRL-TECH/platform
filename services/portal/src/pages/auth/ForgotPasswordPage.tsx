import { Link } from 'react-router-dom'
import { Mail } from 'lucide-react'

export function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0f172a] px-4">
      <div className="w-full max-w-sm">
        <div className="card text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <Mail size={20} className="text-blue-400" />
          </div>
          <h1 className="text-xl font-semibold text-white">Password reset</h1>
          <p className="text-sm text-slate-400">
            Password resets are handled manually for now. Please contact{' '}
            <a href="mailto:support@gctrl.tech" className="text-blue-400 hover:text-blue-300">
              support@gctrl.tech
            </a>{' '}
            and we'll reset your password within 24 hours.
          </p>
          <Link to="/login" className="btn-secondary w-full justify-center block">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  )
}
