package sk.surfspirit.pos.core

import android.content.Context
import android.content.SharedPreferences

/**
 * Jednoduché perzistentné nastavenia (SharedPreferences) — adresa servera,
 * JWT token a prihlásený user. Synchronné, bez coroutine zložitosti.
 * Inicializuj raz v MainActivity cez AppPrefs.init(context).
 */
object AppPrefs {
    private lateinit var sp: SharedPreferences
    private const val K_SERVER = "server_url"
    private const val K_TOKEN = "jwt"
    private const val K_USER = "user_name"
    private const val K_ROLE = "user_role"

    fun init(ctx: Context, defaultServer: String) {
        sp = ctx.getSharedPreferences("surfspirit_pos", Context.MODE_PRIVATE)
        if (sp.getString(K_SERVER, null).isNullOrBlank()) {
            sp.edit().putString(K_SERVER, defaultServer).apply()
        }
    }

    /** Normalizovaná base URL (vždy s schémou, bez trailing slash). */
    var serverUrl: String
        get() = sp.getString(K_SERVER, "") ?: ""
        set(value) = sp.edit().putString(K_SERVER, normalizeUrl(value)).apply()

    var token: String?
        get() = sp.getString(K_TOKEN, null)
        set(value) = sp.edit().putString(K_TOKEN, value).apply()

    var userName: String?
        get() = sp.getString(K_USER, null)
        set(value) = sp.edit().putString(K_USER, value).apply()

    /** Staff id — admin WebView ho potrebuje v sessionStorage pos_user. */
    var userId: Int
        get() = sp.getInt("user_id", 0)
        set(value) = sp.edit().putInt("user_id", value).apply()

    var role: String?
        get() = sp.getString(K_ROLE, null)
        set(value) = sp.edit().putString(K_ROLE, value).apply()

    val isLoggedIn: Boolean get() = !token.isNullOrBlank()

    fun logout() {
        sp.edit().remove(K_TOKEN).remove(K_USER).remove(K_ROLE).remove("session_start").apply()
    }

    /** Generické raw string accessory — používa Store (cache/drafty/queue). */
    fun getRaw(key: String): String? = sp.getString(key, null)
    fun putRaw(key: String, value: String) { sp.edit().putString(key, value).apply() }

    /** "192.168.1.235:3080" → "http://192.168.1.235:3080"; orezáva trailing "/". */
    fun normalizeUrl(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return s
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s.trimEnd('/')
    }
}
