#!/bin/sh
# librespot --onevent hook: hands the playback event to the DSP, which uses it
# to find the exact boundary between the old and the new track. printf is a
# shell builtin, so this costs a few milliseconds (curl took 50–100 ms).
[ -p "$SPOTAMP_EVENT_FIFO" ] && printf '%s %s\n' "$PLAYER_EVENT" "$TRACK_ID" > "$SPOTAMP_EVENT_FIFO"
exit 0
