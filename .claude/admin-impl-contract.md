# Native Admin screen — implementation contract

You are writing ONE Kotlin file: `android-tablet/app/src/main/java/sk/surfspirit/pos/ui/admin/pages/<Name>Screen.kt`
(package `sk.surfspirit.pos.ui.admin.pages`). It must compile standalone against the scaffolding below — do NOT edit any other file.

## Read first
1. Your page spec(s): `.claude/admin-specs/<page>.json` — endpoints with EXACT server shapes, UI sections, actions, implNotes. Trust `resp` shapes (they note Drizzle numeric-as-STRING columns). If anything is ambiguous, open the original `admin/pages/<page>.js` and/or the `server/routes/*.js` route.
2. Skim `android-tablet/app/src/main/java/sk/surfspirit/pos/ui/admin/AdminUi.kt` (shared components) and one existing screen if present.

## API access (per-file, no shared edits)
Define private DTOs + a private Retrofit interface in YOUR file, created via the shared factory:

```kotlin
@Serializable private data class XyzDto(val id: Int, val total: String = "0", ...)  // numeric DB columns are STRINGS unless spec says number!

private interface XyzApi {
    @GET("api/reports/z-report") suspend fun zReport(@Query("date") date: String): ZReportDto
    @POST("api/...") suspend fun act(@Path("id") id: Int, @Body body: ReqDto): JsonElement // use JsonElement when resp shape is irrelevant/object-or-array
}
private val api: XyzApi by lazy { Api.create(XyzApi::class.java) }
```
Imports: `sk.surfspirit.pos.net.Api`, `kotlinx.serialization.Serializable`, `kotlinx.serialization.json.JsonElement`, retrofit2.http.*. Json config: ignoreUnknownKeys, coerceInputValues, encodeDefaults=true, explicitNulls=false — already global.
Prefix all DTO/interface names with a unique screen prefix (e.g. `Cf` for Cashflow) to avoid clashes across files.

## Screen shape
```kotlin
@Composable
fun CashflowScreen() {
    val toast = rememberAdminToast()
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) } ; var error by remember { mutableStateOf<String?>(null) }
    // state + fun load() { scope.launch { try { withContext(Dispatchers.IO){...} ; error=null } catch(e:Exception){ if (e.httpCode()==401){} ; error=errorMessage(e) } finally { loading=false } } }
    LaunchedEffect(Unit) { load() }
    AdminScreenBox(toast) {  // scrollable Column; use scrollable=false + own LazyColumn for long lists
        AdminSectionTitle("…")
        when { loading -> LoadingBox(); error != null -> ErrorBox(error!!) { load() }; else -> { /* content */ } }
    }
}
```

## Shared components (package sk.surfspirit.pos.ui.admin)
- `AdminScreenBox(toast, scrollable=true) { … }` — screen wrapper + toast overlay; `toast.show("msg")` / `toast.show("msg", error=true)`
- `AdminSectionTitle(title, action = { … }?)`, `AdminCard { … }`, `StatCard(label, value, accent=Terra, sub=?, subColor=?)`
- `TableHeader("Stĺpec" to 2f, "Suma" to 1f, …)` + `TableRow(cells = listOf("a" to 2f, "b" to 1f), cellColors=?, onClick=?)`
- `PillTabs(tabs, selected, onSelect)`, `StatusBadge(text, color)`, `DateNav(label, onPrev, onNext, onToday?)`
- `BarChart(values: List<Double>, labels: List<String>, barColor=Terra, height=140)`
- `LoadingBox()`, `ErrorBox(msg){retry}`, `EmptyHint(text)`, `FormField(label, value, onChange, placeholder=, keyboard=, suffix=)`
- `AdminConfirm(title, text, confirmLabel, danger, onConfirm, onDismiss)`

## Core helpers (package sk.surfspirit.pos.core)
- `money(Double)` → "12,50 €" · `fmtCost(Double)` → sub-cent adaptive (NO € appended) · `fmtBratislava(iso, "dd.MM. HH:mm")`
- `errorMessage(Throwable)`, `Throwable.httpCode()`, `isManager`, `AppPrefs.role/userName`
- Theme (sk.surfspirit.pos.ui.theme): `Terra, Sage, Amber, Navy, Danger, Cream, CreamElev, Espresso, EspressoSoft, EspressoDim, BorderSoft/Mid/Strong`, `Motion`, `paperShadow(dp, shape)`, `pressScale(interaction)`, `AnimatedMoney(value, style, color)`

## Rules
- Slovak UI texts exactly as the web (spec `ui`/`actions` carries them). sk-SK decimal COMMA everywhere (money()/fmtCost do it).
- Dates/times shown via fmtBratislava (Europe/Bratislava) — never device-default zone for server timestamps.
- Parse Drizzle string-numerics with `.toDoubleOrNull() ?: 0.0`.
- Confirmations for destructive actions via AdminConfirm (danger=true). Toast after every action (Slovak, per spec).
- Role gating: server enforces; hide manager-only ACTIONS when `!isManager` if the spec marks role.
- Tablet density: tables over cards; no fixed heights that can clip text; tap targets ≥44dp for standalone buttons.
- NO new Gradle deps, NO ViewModel, NO Navigation — plain composable + remember/LaunchedEffect. No edits outside your file.
- Keep it compiling: prefer simple Kotlin; avoid experimental APIs except ExperimentalFoundationApi/ExperimentalLayoutApi if needed (annotate @OptIn).

## Output
Write the file via Write tool. Then in your final message: one line status + the exact file path + any spec ambiguity you resolved (and how).
