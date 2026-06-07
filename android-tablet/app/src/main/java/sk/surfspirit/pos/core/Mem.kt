package sk.surfspirit.pos.core

import sk.surfspirit.pos.net.CategoryDto
import sk.surfspirit.pos.net.DiscountDto
import sk.surfspirit.pos.net.OrderDto
import sk.surfspirit.pos.net.TableDto
import sk.surfspirit.pos.net.ZoneDto

/**
 * In-memory cache pre okamžité prechody Floor ↔ Order — obrazovka sa
 * vykreslí HNEĎ z posledných známych dát (žiadny spinner), sieť beží
 * potichu na pozadí a stav sa len doplní. Menu sa považuje za čerstvé
 * 5 min (mení sa cez admin zriedka); objednávky sa fetchnú vždy, ale
 * bez blokovania prvého framu.
 */
object Mem {
    /** Kategórie UŽ pripravené pre UI (sorted + „Najčastejšie" prvá). */
    @Volatile var categories: List<CategoryDto>? = null
    @Volatile var categoriesAt: Long = 0
    @Volatile var tables: List<TableDto>? = null
    @Volatile var zones: List<ZoneDto>? = null
    @Volatile var discounts: List<DiscountDto>? = null
    @Volatile var orders: List<OrderDto>? = null      // všetky otvorené (floor)
    @Volatile var revenueToday: Double? = null

    const val MENU_TTL_MS = 5 * 60 * 1000L

    val menuFresh: Boolean
        get() = categories != null && System.currentTimeMillis() - categoriesAt < MENU_TTL_MS

    fun clear() {
        categories = null; categoriesAt = 0
        tables = null; zones = null; discounts = null; orders = null; revenueToday = null
    }
}
