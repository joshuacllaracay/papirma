import { useEffect, useState } from 'react'
import { track } from '../lib/analytics'
import { Icon } from './Icon'
import { rememberRating } from '../lib/rating'

const LABELS = ['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent']
/** GA4 caps event parameter values at 100 characters. */
const COMMENT_LIMIT = 100

export function RatingDialog({ onClose }: { onClose: () => void }) {
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState('')
  const [sent, setSent] = useState(false)

  const dismiss = () => {
    if (!sent) {
      rememberRating('dismissed')
      track('rating_dismissed')
    }
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismiss()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!sent) return
    const t = setTimeout(onClose, 1800)
    return () => clearTimeout(t)
  }, [sent, onClose])

  const submit = () => {
    if (!rating) return
    const text = comment.trim()
    track('app_rating', { rating, ...(text ? { comment: text } : {}) })
    rememberRating(String(rating))
    setSent(true)
  }

  const shown = hover || rating

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl" role="dialog" aria-label="Rate PirmaNest">
        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="absolute top-3 right-3 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <Icon name="x" className="h-4 w-4" />
        </button>

        {sent ? (
          <div className="py-6">
            <div className="text-3xl">🎉</div>
            <h2 className="mt-2 text-lg font-semibold">Thank you!</h2>
            <p className="mt-1 text-sm text-slate-500">Your feedback helps make PirmaNest better.</p>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Your PDF is signed!</h2>
            <p className="mt-1 text-sm text-slate-500">How was your experience with PirmaNest?</p>

            <div className="mt-4 flex justify-center gap-1" onPointerLeave={() => setHover(0)} role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  onPointerEnter={() => setHover(n)}
                  onClick={() => setRating(n)}
                  className="p-1 transition-transform hover:scale-110"
                >
                  <svg viewBox="0 0 24 24" className="h-9 w-9" aria-hidden="true">
                    <path
                      d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9L12 2.5z"
                      fill={n <= shown ? '#f59e0b' : 'none'}
                      stroke={n <= shown ? '#f59e0b' : '#cbd5e1'}
                      strokeWidth={1.6}
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
            <p className="h-5 text-sm font-medium text-amber-600">{LABELS[shown]}</p>

            {rating > 0 && (
              <div className="mt-3 text-left">
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, COMMENT_LIMIT))}
                  rows={3}
                  placeholder={rating <= 3 ? 'What could we do better? (optional)' : 'What did you like? (optional)'}
                  className="w-full resize-none rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <p className="text-right text-xs text-slate-400">
                  {comment.length}/{COMMENT_LIMIT}
                </p>
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={dismiss} className="flex-1 rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
                Not now
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!rating}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                Submit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
