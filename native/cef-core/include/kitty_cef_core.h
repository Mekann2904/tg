#ifndef KITTY_CEF_CORE_H
#define KITTY_CEF_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ */
/* Opaque core handle                                                  */
/* ------------------------------------------------------------------ */

struct KittyCore;

/* ------------------------------------------------------------------ */
/* Frame metadata (returned by kitty_core_write_bgra_frame)            */
/* ------------------------------------------------------------------ */

struct KittyCoreFrameMeta {
  uint64_t seq;
  uint32_t width;
  uint32_t height;
  size_t   byte_len;
  const char* path_ptr;
  uint32_t dirty_valid;
  uint32_t dirty_x;
  uint32_t dirty_y;
  uint32_t dirty_width;
  uint32_t dirty_height;
};

/* ------------------------------------------------------------------ */
/* Command kinds                                                       */
/* ------------------------------------------------------------------ */

#define KITTY_CORE_CMD_STOP       0
#define KITTY_CORE_CMD_NAVIGATE   1
#define KITTY_CORE_CMD_RESIZE     2
#define KITTY_CORE_CMD_CLICK      3
#define KITTY_CORE_CMD_MOUSE_DOWN 4
#define KITTY_CORE_CMD_MOUSE_UP   5
#define KITTY_CORE_CMD_MOUSE_MOVE 6
#define KITTY_CORE_CMD_WHEEL      7
#define KITTY_CORE_CMD_KEY        8
#define KITTY_CORE_CMD_TEXT        9

/* ------------------------------------------------------------------ */
/* Mouse button constants                                              */
/* ------------------------------------------------------------------ */

#define KITTY_CORE_BUTTON_LEFT   0
#define KITTY_CORE_BUTTON_MIDDLE 1
#define KITTY_CORE_BUTTON_RIGHT  2
#define KITTY_CORE_BUTTON_NONE    3
#define KITTY_CORE_BUTTON_BACK    4
#define KITTY_CORE_BUTTON_FORWARD 5

/* ------------------------------------------------------------------ */
/* Modifier bit flags                                                  */
/* ------------------------------------------------------------------ */

#define KITTY_CORE_MOD_SHIFT 0x01
#define KITTY_CORE_MOD_CTRL  0x02
#define KITTY_CORE_MOD_ALT   0x04
#define KITTY_CORE_MOD_META  0x08

/* ------------------------------------------------------------------ */
/* Parsed command (output of kitty_core_parse_command_json)            */
/* ------------------------------------------------------------------ */

struct KittyCoreCommandMeta {
  /* Common */
  uint32_t kind;

  /* navigate */
  const char* url_ptr;

  /* resize */
  uint32_t width;
  uint32_t height;

  /* mouse / wheel */
  int32_t  x;
  int32_t  y;
  uint32_t button;
  uint32_t click_count;
  int32_t  delta_x;
  int32_t  delta_y;
  uint32_t modifiers;

  /* key / text */
  const char* key_ptr;
  const char* text_ptr;
};

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

KittyCore* kitty_core_new(bool debug);
void       kitty_core_free(KittyCore* core);
const char* kitty_core_last_error(const KittyCore* core);

/* ------------------------------------------------------------------ */
/* Frame pipeline                                                      */
/* ------------------------------------------------------------------ */

void kitty_core_force_full_frame(KittyCore* core);

int kitty_core_write_bgra_frame(
  KittyCore*          core,
  const void*         bgra_ptr,
  size_t              bgra_len,
  uint32_t            width,
  uint32_t            height,
  bool                rgb,
  uint32_t            dirty_valid,
  uint32_t            dirty_x,
  uint32_t            dirty_y,
  uint32_t            dirty_width,
  uint32_t            dirty_height,
  KittyCoreFrameMeta* out
);

/* ------------------------------------------------------------------ */
/* Command parsing                                                     */
/* ------------------------------------------------------------------ */

int kitty_core_parse_command_json(
  KittyCore*             core,
  const uint8_t*         json_ptr,
  size_t                 json_len,
  KittyCoreCommandMeta*  out
);


/* ------------------------------------------------------------------ */
/* Semantic / DOM policy helpers                                      */
/* ------------------------------------------------------------------ */

const char* kitty_core_build_cursor_event_json(
  KittyCore* core,
  const char* cursor
);

const char* kitty_core_build_insert_text_js(
  KittyCore* core,
  const char* text
);

const char* kitty_core_build_edit_key_js(
  KittyCore* core,
  const char* key
);

const char* kitty_core_build_assist_click_js(
  KittyCore* core,
  int32_t x,
  int32_t y
);

const char* kitty_core_build_hit_test_js(
  KittyCore* core,
  int32_t x,
  int32_t y
);

const char* kitty_core_strip_hit_test_console_prefix(
  KittyCore* core,
  const char* message
);

#ifdef __cplusplus
}
#endif

#endif /* KITTY_CEF_CORE_H */
