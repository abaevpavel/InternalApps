import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Mail } from 'lucide-react'
import { Button, Card, Input } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { isValidEmail, setupGmailAuth } from '../../services/gmail-auth'

type Status = { type: 'success' | 'error'; msg: string } | null

export function GmailAutoSenderPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  async function submit() {
    setStatus(null)
    if (!isValidEmail(email)) {
      setStatus({ type: 'error', msg: 'Please enter a valid email address.' })
      return
    }
    setLoading(true)
    try {
      const url = await setupGmailAuth(email.trim())
      window.open(url, '_blank', 'noopener')
      setStatus({ type: 'success', msg: 'Authorization page opened in a new tab. Complete the Google consent there.' })
    } catch (e) {
      setStatus({ type: 'error', msg: errMsg(e) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      {/* form card */}
      <Card className="px-8 py-10">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 text-brand-blue">
          <Mail size={28} />
        </div>
        <h1 className="text-center text-2xl font-bold text-gray-900">Gmail Auto Sender Setup</h1>

        <label className="mt-8 block text-sm font-medium text-gray-700">
          Please enter email address to auto send emails from:
        </label>
        <Input
          className="mt-2"
          type="email"
          placeholder="Enter email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !loading && submit()}
          disabled={loading}
        />
        <Button variant="blue" className="mt-4 w-full py-3" onClick={submit} disabled={loading || !email.trim()}>
          {loading ? 'Setting up…' : 'Setup Gmail Auth'}
        </Button>

        {status && (
          <div
            className={cn(
              'mt-4 flex items-start gap-2 rounded-lg px-4 py-3 text-sm',
              status.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700',
            )}
          >
            {status.type === 'success' ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            )}
            <span>{status.msg}</span>
          </div>
        )}
      </Card>

      {/* instructions */}
      <h2 className="mt-12 text-center text-xl font-bold text-gray-900">What to expect during Gmail authorization</h2>
      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <InstructionTile
          n={1}
          tone="amber"
          title="Google Verification Warning"
          body={
            <>
              You'll see a warning that <b>"Google hasn't verified this app"</b> because this is a development
              application.
            </>
          }
          caption='Click the "Advanced" button to proceed'
          mock={<GoogleWarning step={1} />}
        />
        <InstructionTile
          n={2}
          tone="blue"
          title="Continue to Authorization"
          body={<>After clicking "Advanced", you'll see an option to continue to the authorization page.</>}
          caption='Click the "Go to…" link to complete authorization'
          mock={<GoogleWarning step={2} />}
        />
      </div>

      {/* why */}
      <div className="mt-5 rounded-xl border border-green-200 bg-green-50/60 px-6 py-5 text-center text-sm text-green-800">
        <b>Why this happens:</b> This warning appears because the Gmail integration is in development mode. In
        production, the app would be verified by Google to remove this warning.
      </div>
    </div>
  )
}

/* ---------------- instruction tile ---------------- */

const tones = {
  amber: { wrap: 'border-amber-200 bg-amber-50/60', badge: 'bg-amber-200 text-amber-800', text: 'text-amber-900', cap: 'text-amber-700' },
  blue: { wrap: 'border-blue-200 bg-blue-50/60', badge: 'bg-blue-200 text-blue-800', text: 'text-blue-900', cap: 'text-blue-700' },
}

function InstructionTile({
  n,
  tone,
  title,
  body,
  caption,
  mock,
}: {
  n: number
  tone: keyof typeof tones
  title: string
  body: React.ReactNode
  caption: string
  mock: React.ReactNode
}) {
  const t = tones[tone]
  return (
    <div className={cn('rounded-xl border p-5', t.wrap)}>
      <div className="flex items-start gap-3">
        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', t.badge)}>
          {n}
        </span>
        <h3 className={cn('font-bold', t.text)}>{title}</h3>
      </div>
      <p className={cn('mt-3 text-sm', t.text)}>{body}</p>
      <div className="mt-3">{mock}</div>
      <p className={cn('mt-3 text-sm font-medium', t.cap)}>{caption}</p>
    </div>
  )
}

/* ---------------- recreated Google "unverified app" warning ---------------- */

function GoogleWarning({ step }: { step: 1 | 2 }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-left">
      <div className="mb-3 text-red-500">
        <AlertTriangle size={26} fill="currentColor" className="text-red-500" />
      </div>
      <div className="text-[13px] font-semibold text-gray-800">Google hasn't verified this app</div>
      <p className="mt-1 text-[10px] leading-snug text-gray-500">
        The app is requesting access to sensitive info in your Google Account. Until the developer{' '}
        <span className="text-blue-600 underline">(abaevb@gmail.com)</span> verifies this app with Google, you shouldn't
        use it.
      </p>

      {step === 1 ? (
        <div className="mt-4 flex items-end justify-between">
          <div className="flex flex-col items-center">
            <span className="rounded border-2 border-red-500 px-2 py-0.5 text-[10px] text-gray-600 underline">Advanced</span>
            <span className="mt-1 text-[10px] font-bold text-red-500">click here</span>
          </div>
          <span className="rounded bg-blue-500 px-2.5 py-1 text-[10px] font-semibold text-white">BACK TO SAFETY</span>
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-600 underline">Hide Advanced</span>
            <span className="rounded bg-blue-500 px-2.5 py-1 text-[10px] font-semibold text-white">BACK TO SAFETY</span>
          </div>
          <p className="mt-3 text-[10px] leading-snug text-gray-500">
            Continue only if you understand the risks and trust the developer{' '}
            <span className="text-blue-600 underline">(abaevb@gmail.com)</span>.
          </p>
          <div className="mt-2 flex flex-col items-center">
            <span className="rounded border-2 border-red-500 px-2 py-1 text-center text-[10px] text-gray-600 underline">
              Go to 3mb71kyw2k.execute-api.us-east-1.amazonaws.com (unsafe)
            </span>
            <span className="mt-1 text-[10px] font-bold text-red-500">click here</span>
          </div>
        </div>
      )}
    </div>
  )
}
