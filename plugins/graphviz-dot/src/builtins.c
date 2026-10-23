/* Statically linked Graphviz plugins.
 *
 * Graphviz normally finds its layout engines and renderers by dlopen()ing
 * shared libraries. A Plugin ABI 1 module has no filesystem and no dynamic
 * loading, so the two plugins we need are registered through the
 * `lt_preloaded_symbols` table that gvContextPlugins() accepts instead:
 *
 *   dot_layout  the `dot` hierarchical layout engine
 *   core        the SVG renderer only (upstream's core plugin also carries
 *               PostScript, FIG, JSON, ... which we do not ship)
 *
 * Text is measured with Graphviz's built-in font metric tables (no textlayout
 * plugin is linked), so layout does not depend on any installed font. */

#include <gvc/gvcext.h>
#include <gvc/gvplugin.h>

extern gvplugin_installed_t gvdevice_svg_types[];
extern gvplugin_installed_t gvrender_svg_types[];

static gvplugin_api_t core_apis[] = {
    {API_device, gvdevice_svg_types},
    {API_render, gvrender_svg_types},
    {(api_t)0, 0},
};

static gvplugin_library_t core_library = {"core", core_apis};
extern gvplugin_library_t gvplugin_dot_layout_LTX_library;

lt_symlist_t lt_preloaded_symbols[] = {
    {"gvplugin_core_LTX_library", &core_library},
    {"gvplugin_dot_layout_LTX_library", &gvplugin_dot_layout_LTX_library},
    {0, 0},
};
