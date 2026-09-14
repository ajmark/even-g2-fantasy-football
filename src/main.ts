import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const SLEEPER_API = 'https://api.sleeper.app/v1'

const STORAGE_KEY_USER_ID = 'sleeperUserId'
const STORAGE_KEY_DISPLAY_NAME = 'sleeperDisplayName'

const MAIN_CONTAINER_ID = 1
const MAIN_CONTAINER_NAME = 'main'

interface SleeperState {
  week: number
  display_week?: number
  season: string
  league_season?: string
}

interface SleeperLeague {
  league_id: string
  name: string
}

interface SleeperRoster {
  roster_id: number
  owner_id: string | null
}

interface SleeperMatchup {
  roster_id: number
  matchup_id: number | null
  points: number
  starters: string[]
}

interface SleeperUser {
  user_id: string
  display_name: string
}

interface SleeperLeagueDetail {
  scoring_settings: Record<string, number>
}

interface SleeperProjection {
  player_id: string
  stats: Record<string, number>
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SLEEPER_API}${path}`)
  if (!res.ok) throw new Error(`Sleeper API ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function resolveSleeperUser(usernameOrId: string): Promise<SleeperUser | null> {
  const res = await fetch(`${SLEEPER_API}/user/${encodeURIComponent(usernameOrId)}`)
  if (!res.ok) return null
  const data = (await res.json()) as SleeperUser | null
  if (!data || !data.user_id) return null
  return data
}

const PROJECTIONS_BASE = 'https://api.sleeper.app/projections/nfl'
const PROJECTION_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

let projectionsCache: { key: string; points: Map<string, number> } | null = null

function computeProjectedPoints(stats: Record<string, number>, scoring: Record<string, number>): number {
  let total = 0
  for (const [statKey, weight] of Object.entries(scoring)) {
    const value = stats[statKey]
    if (typeof value === 'number') total += value * weight
  }
  return total
}

async function getProjectedPointsMap(
  season: string,
  week: number,
  scoring: Record<string, number>,
): Promise<Map<string, number>> {
  const key = `${season}-${week}`
  if (projectionsCache?.key === key) return projectionsCache.points

  const positionParams = PROJECTION_POSITIONS.map((p) => `position[]=${p}`).join('&')
  const res = await fetch(`${PROJECTIONS_BASE}/${season}/${week}?season_type=regular&${positionParams}`)
  if (!res.ok) throw new Error(`Sleeper projections failed: ${res.status}`)
  const projections = (await res.json()) as SleeperProjection[]

  const points = new Map<string, number>()
  for (const proj of projections) {
    points.set(proj.player_id, computeProjectedPoints(proj.stats ?? {}, scoring))
  }
  projectionsCache = { key, points }
  return points
}

function sumProjected(starters: string[], points: Map<string, number>): number {
  return starters.reduce((sum, id) => sum + (points.get(id) ?? 0), 0)
}

function projSuffix(projected: number | null): string {
  return projected !== null ? ` (proj ${projected.toFixed(1)})` : ''
}

async function fetchMatchupText(sleeperUserId: string): Promise<string> {
  const state = await getJson<SleeperState>('/state/nfl')
  const season = state.league_season ?? state.season
  const week = state.display_week ?? state.week

  const leagues = await getJson<SleeperLeague[]>(`/user/${sleeperUserId}/leagues/nfl/${season}`)
  const league = leagues[0]
  if (!league) return 'No active Sleeper\nleagues found.'

  const [rosters, matchups, users, leagueDetail] = await Promise.all([
    getJson<SleeperRoster[]>(`/league/${league.league_id}/rosters`),
    getJson<SleeperMatchup[]>(`/league/${league.league_id}/matchups/${week}`),
    getJson<SleeperUser[]>(`/league/${league.league_id}/users`),
    getJson<SleeperLeagueDetail>(`/league/${league.league_id}`),
  ])

  const myRoster = rosters.find((r) => r.owner_id === sleeperUserId)
  if (!myRoster) return `${league.name}\nNo roster found\nfor this user.`

  const myMatchup = matchups.find((m) => m.roster_id === myRoster.roster_id)
  if (!myMatchup || myMatchup.matchup_id === null) {
    return `${league.name}\nWeek ${week}\n\nNo matchup\nthis week (bye).`
  }

  const oppMatchup = matchups.find(
    (m) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== myRoster.roster_id,
  )

  const nameByRosterId = (rosterId: number): string => {
    const roster = rosters.find((r) => r.roster_id === rosterId)
    const user = roster?.owner_id ? users.find((u) => u.user_id === roster.owner_id) : undefined
    return user?.display_name ?? `Team ${rosterId}`
  }

  const myPoints = myMatchup.points ?? 0
  const myName = nameByRosterId(myRoster.roster_id)

  const projectedPoints = await getProjectedPointsMap(season, week, leagueDetail.scoring_settings).catch((err) => {
    console.error('Failed to fetch Sleeper projections:', err)
    return null
  })
  const myProjected = projectedPoints ? sumProjected(myMatchup.starters ?? [], projectedPoints) : null

  if (!oppMatchup) {
    return `${league.name}\nWeek ${week}\n\n${myName}: ${myPoints.toFixed(2)}${projSuffix(myProjected)}\n\nWaiting on opponent.`
  }

  const oppPoints = oppMatchup.points ?? 0
  const oppName = nameByRosterId(oppMatchup.roster_id)
  const oppProjected = projectedPoints ? sumProjected(oppMatchup.starters ?? [], projectedPoints) : null

  let status = 'TIED'
  if (myPoints > oppPoints) status = 'WINNING'
  else if (myPoints < oppPoints) status = 'LOSING'

  return [
    `${league.name}`,
    `Week ${week} - ${status}`,
    '',
    `${myName}: ${myPoints.toFixed(2)}${projSuffix(myProjected)}`,
    `${oppName}: ${oppPoints.toFixed(2)}${projSuffix(oppProjected)}`,
    '',
    '(tap to refresh)',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Glasses display (renders into the G2 via the bridge)
// ---------------------------------------------------------------------------

let currentSleeperUserId: string | null = null
let glassesContainerCreated = false

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: MAIN_CONTAINER_ID,
  containerName: MAIN_CONTAINER_NAME,
  content: 'Loading fantasy\nfootball score...',
  isEventCapture: 1,
})

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear() % 100)}`
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${datePart} ${timePart}`
}

async function refreshScore(bridge: EvenAppBridge) {
  if (!currentSleeperUserId) return
  const text = await fetchMatchupText(currentSleeperUserId)
    .then((matchup) => `${matchup}\nUpdated ${formatTimestamp(new Date())}`)
    .catch((err) => {
      console.error('Failed to fetch Sleeper matchup:', err)
      return 'Could not load score.\nTap to retry.'
    })
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: MAIN_CONTAINER_ID,
    containerName: MAIN_CONTAINER_NAME,
    content: text,
    contentOffset: 0,
    contentLength: 0,
  }))
}

async function ensureGlassesContainer(bridge: EvenAppBridge): Promise<boolean> {
  if (glassesContainerCreated) return true

  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }))
  if (result !== 0) {
    console.error('Failed to create glasses container:', result)
    return false
  }
  glassesContainerCreated = true

  const IGNORED_SYS_EVENTS = new Set<number>([
    OsEventTypeList.IMU_DATA_REPORT,
    OsEventTypeList.FOREGROUND_EXIT_EVENT,
    OsEventTypeList.SYSTEM_EXIT_EVENT,
    OsEventTypeList.ABNORMAL_EXIT_EVENT,
    OsEventTypeList.SCROLL_TOP_EVENT,
    OsEventTypeList.SCROLL_BOTTOM_EVENT,
  ])

  bridge.onEvenHubEvent((event) => {
    // Taps on the full-screen text container surface as a Sys_ItemEvent rather
    // than a Text_ItemEvent, and the CLICK_EVENT (0) type is sometimes omitted
    // entirely — treat any un-ignored sysEvent as "tap to refresh".
    const sys = event.sysEvent
    if (!sys) return
    if (sys.eventType !== undefined && IGNORED_SYS_EVENTS.has(sys.eventType)) return
    void refreshScore(bridge)
  })

  return true
}

async function showScoresForUser(bridge: EvenAppBridge, userId: string, displayName: string) {
  currentSleeperUserId = userId
  renderConnectedScreen(bridge, userId, displayName)
  const ready = await ensureGlassesContainer(bridge)
  if (ready) await refreshScore(bridge)
}

async function connectSleeperUser(bridge: EvenAppBridge, userId: string, displayName: string) {
  await bridge.setLocalStorage(STORAGE_KEY_USER_ID, userId)
  await bridge.setLocalStorage(STORAGE_KEY_DISPLAY_NAME, displayName)
  await showScoresForUser(bridge, userId, displayName)
}

// ---------------------------------------------------------------------------
// Phone-side UI (renders into the WebView on the phone)
// ---------------------------------------------------------------------------

const appEl = document.getElementById('app')!

function injectPhoneStyles() {
  const style = document.createElement('style')
  style.textContent = `
    :root {
      --color-text: #232323;
      --color-text-dim: #7B7B7B;
      --color-bg: #FFFFFF;
      --color-surface: #EEEEEE;
      --color-input-bg: rgba(35,35,35,0.08);
      --color-accent: #FEF991;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --color-text: #FFFFFF;
        --color-text-dim: #8A8A8A;
        --color-bg: #111111;
        --color-surface: #1A1A1A;
        --color-input-bg: rgba(255,255,255,0.08);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--color-bg);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      letter-spacing: -0.01em;
    }
    .screen {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 360px;
      background: var(--color-surface);
      border-radius: 16px;
      padding: 24px 20px;
    }
    .eh-label {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-dim);
      margin-bottom: 8px;
    }
    .eh-title {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin: 0 0 12px;
      word-break: break-word;
    }
    .eh-body {
      font-size: 16px;
      line-height: 1.4;
      margin: 0 0 20px;
    }
    .eh-dim { color: var(--color-text-dim); }
    .eh-input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: none;
      background: var(--color-input-bg);
      color: var(--color-text);
      font-size: 16px;
      margin-bottom: 12px;
    }
    .eh-input::placeholder { color: var(--color-text-dim); }
    .eh-button {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: none;
      background: var(--color-accent);
      color: var(--color-text);
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    .eh-button:disabled { opacity: 0.5; cursor: default; }
    .eh-button.secondary {
      background: transparent;
      color: var(--color-text);
      border: 1px solid var(--color-input-bg);
      margin-top: 12px;
    }
    .eh-caption {
      font-size: 13px;
      margin-top: 12px;
    }
    .eh-error { color: #D64545; }
    [hidden] { display: none !important; }
  `
  document.head.appendChild(style)
}

function renderSetupScreen(bridge: EvenAppBridge) {
  appEl.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="eh-label">Setup</div>
        <h1 class="eh-title">Connect Sleeper</h1>
        <p class="eh-body eh-dim">Enter your Sleeper username or user ID to show your fantasy matchup on the glasses.</p>
        <input class="eh-input" type="text" placeholder="Sleeper username or ID" autocapitalize="off" autocorrect="off" />
        <button class="eh-button">Connect</button>
        <p class="eh-caption eh-error" hidden></p>
      </div>
    </div>
  `

  const input = appEl.querySelector<HTMLInputElement>('.eh-input')!
  const button = appEl.querySelector<HTMLButtonElement>('.eh-button')!
  const error = appEl.querySelector<HTMLParagraphElement>('.eh-error')!

  async function submit() {
    const value = input.value.trim()
    if (!value) {
      error.textContent = 'Enter a username or user ID.'
      error.hidden = false
      return
    }

    button.disabled = true
    button.textContent = 'Connecting...'
    error.hidden = true

    try {
      const user = await resolveSleeperUser(value)
      if (!user) {
        error.textContent = "Couldn't find that Sleeper account. Check the spelling and try again."
        error.hidden = false
        return
      }
      await connectSleeperUser(bridge, user.user_id, user.display_name)
    } catch (err) {
      console.error('Failed to resolve Sleeper user:', err)
      error.textContent = 'Network error — please try again.'
      error.hidden = false
    } finally {
      button.disabled = false
      button.textContent = 'Connect'
    }
  }

  button.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
}

function renderConnectedScreen(bridge: EvenAppBridge, userId: string, displayName: string) {
  appEl.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="eh-label">Connected</div>
        <h1 class="eh-title"></h1>
        <p class="eh-body eh-dim">Fantasy scores are showing on your G2 glasses. Tap the glasses display to refresh.</p>
        <button class="eh-button secondary">Change account</button>
      </div>
    </div>
  `

  appEl.querySelector<HTMLHeadingElement>('.eh-title')!.textContent = displayName || userId

  const changeButton = appEl.querySelector<HTMLButtonElement>('.eh-button.secondary')!
  changeButton.addEventListener('click', async () => {
    await bridge.setLocalStorage(STORAGE_KEY_USER_ID, '')
    await bridge.setLocalStorage(STORAGE_KEY_DISPLAY_NAME, '')
    renderSetupScreen(bridge)
  })
}

async function initPhoneUi() {
  injectPhoneStyles()
  const bridge = await waitForEvenAppBridge()

  const storedUserId = await bridge.getLocalStorage(STORAGE_KEY_USER_ID)
  if (storedUserId) {
    const storedDisplayName = await bridge.getLocalStorage(STORAGE_KEY_DISPLAY_NAME)
    await showScoresForUser(bridge, storedUserId, storedDisplayName)
  } else {
    renderSetupScreen(bridge)
  }
}

void initPhoneUi()
