cmake_minimum_required(VERSION 3.21)
project(kitty_cef_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED CEF_ROOT)
  message(FATAL_ERROR "CEF_ROOT must point to an extracted CEF binary distribution")
endif()

if(NOT DEFINED CEF_CORE_LIB)
  message(FATAL_ERROR "CEF_CORE_LIB must point to native/cef-core/target/release/libkitty_cef_core.a")
endif()

add_executable(kitty-cef-helper main.cc)

target_include_directories(kitty-cef-helper PRIVATE
  "${CEF_ROOT}"
  "${CEF_ROOT}/include"
  "${CMAKE_CURRENT_SOURCE_DIR}/../cef-core/include"
)

target_link_libraries(kitty-cef-helper PRIVATE "${CEF_CORE_LIB}")

# libcef_dll_wrapper must be built first from the CEF binary distribution:
#   cmake -S "$CEF_ROOT" -B "$CEF_ROOT/build" -DCMAKE_BUILD_TYPE=Release
#   cmake --build "$CEF_ROOT/build" --target libcef_dll_wrapper
set(CEF_WRAPPER "${CEF_ROOT}/build/libcef_dll_wrapper/libcef_dll_wrapper.a")

if(APPLE)
  set(CEF_FW "${CEF_ROOT}/Release/Chromium Embedded Framework.framework")
  if(EXISTS "${CEF_FW}")
    target_link_libraries(kitty-cef-helper PRIVATE
      "${CEF_WRAPPER}"
      "${CEF_FW}/Chromium Embedded Framework"
      "-framework AppKit"
      "-framework Cocoa"
      "-framework IOSurface"
    )
  else()
    target_link_libraries(kitty-cef-helper PRIVATE
      "${CEF_WRAPPER}"
      "${CEF_ROOT}/Release/libcef.dylib"
    )
  endif()
elseif(UNIX)
  target_link_libraries(kitty-cef-helper PRIVATE
    "${CEF_WRAPPER}"
    cef pthread
  )
  target_link_directories(kitty-cef-helper PRIVATE "${CEF_ROOT}/Release")
else()
  target_link_libraries(kitty-cef-helper PRIVATE
    "${CEF_WRAPPER}"
    libcef
  )
  target_link_directories(kitty-cef-helper PRIVATE "${CEF_ROOT}/Release")
endif()

# The CEF binary distribution normally also requires copying resources,
# locales, subprocess helpers, and libcef files beside the executable. Keep that
# packaging step outside this starter CMake so the repo patch remains portable.
