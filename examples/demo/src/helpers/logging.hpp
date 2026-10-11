#pragma once
#include "message.h"

inline void LogStartup() {
    Wh_Log(L"%s", kStartupMessage);
}
