// ==WindhawkMod==
// @id              wham-second-demo
// @name            Second independent demo
// @description     Uses the shared nested header
// @version         1.0.0
// @author          Windhawk Tools
// @include         notepad.exe
// ==/WindhawkMod==

#include <windows.h>
#include "helpers/logging.hpp"

BOOL Wh_ModInit() {
    LogStartup();
    return TRUE;
}
