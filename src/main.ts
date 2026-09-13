import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const SLEEPER_API = 'https://api.sleeper.app/v1'
const SLEEPER_USER_ID = '206491992631287808'

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

async function fetchMatchupText(): Promise<string> {
  const state = await getJson<SleeperState>('/state/nfl')
  const season = state.league_season ?? state.season
  const week = state.display_week ?? state.week

  const leagues = await getJson<SleeperLeague[]>(`/user/${SLEEPER_USER_ID}/leagues/nfl/${season}`)
  const league = leagues[0]
  if (!league) return 'No active Sleeper\nleagues found.'

  const [rosters, matchups, users, leagueDetail] = await Promise.all([
    getJson<SleeperRoster[]>(`/league/${league.league_id}/rosters`),
    getJson<SleeperMatchup[]>(`/league/${league.league_id}/matchups/${week}`),
    getJson<SleeperUser[]>(`/league/${league.league_id}/users`),
    getJson<SleeperLeagueDetail>(`/league/${league.league_id}`),
  ])

  const myRoster = rosters.find((r) => r.owner_id === SLEEPER_USER_ID)
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

const bridge = await waitForEvenAppBridge()

const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [mainText],
}))
console.log('Page created:', result === 0 ? 'success' : 'failed')

async function refreshScore() {
  const text = await fetchMatchupText().catch((err) => {
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

if (result === 0) {
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
    void refreshScore()
  })

  void refreshScore()
}
