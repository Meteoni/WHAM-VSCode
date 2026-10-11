// ==WindhawkMod==
// @id              wham-demo
// @name            Amalgamation demo
// @description     Demonstrates recoverable local includes
// @version         1.0.0
// @author          Windhawk Tools
// @include         notepad.exe
// ==/WindhawkMod==

// ==WindhawkModReadme==
/*
# Amalgamation demo
The text `#include "not-a-header.h"` here is documentation.
*/
// ==/WindhawkModReadme==

// ==WindhawkModSettings==
/*
- enabled: true
  $name: Enable logging
*/
// ==/WindhawkModSettings==

#include <windows.h>
#if WHAM_EXTRA
#include "helpers/logging.hpp"
#endif
#include "helpers/logging.hpp"

BOOL Wh_ModInit() {
    if (Wh_GetIntSetting(L"enabled")) LogStartup();
    return TRUE;
}

void Wh_ModUninit() {
    Wh_Log(L"Amalgamation demo unloaded");
}
