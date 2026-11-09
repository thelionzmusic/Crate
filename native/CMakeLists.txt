# crate-engine: Crate's native audio engine (ASIO / WASAPI on Windows).
#   cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release
# RtAudio (MIT-style licence) is fetched at a pinned version; it carries the ASIO host files.
# CRATE_DEVICES=OFF builds without sound card support (silent "null" output only), for tests.
cmake_minimum_required(VERSION 3.20)
project(crate_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")  # static runtime for us and RtAudio: no VC++ redistributable needed
option(CRATE_DEVICES "Build with sound card support through RtAudio" ON)

add_executable(crate-engine
  src/main.cpp src/mixer.cpp src/deck.cpp src/fx.cpp src/audio_io.cpp src/ws.cpp src/selftest.cpp)

if(CRATE_DEVICES)
  include(FetchContent)
  set(RTAUDIO_BUILD_TESTING OFF CACHE BOOL "" FORCE)
  set(RTAUDIO_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(RTAUDIO_BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  if(WIN32)
    set(RTAUDIO_API_ASIO ON CACHE BOOL "" FORCE)
    set(RTAUDIO_API_WASAPI ON CACHE BOOL "" FORCE)
    set(RTAUDIO_API_DS OFF CACHE BOOL "" FORCE)
  else()
    set(RTAUDIO_API_ALSA OFF CACHE BOOL "" FORCE)    # Linux builds are for tests: the null output is enough
    set(RTAUDIO_API_PULSE OFF CACHE BOOL "" FORCE)
    set(RTAUDIO_API_JACK OFF CACHE BOOL "" FORCE)
  endif()
  FetchContent_Declare(rtaudio GIT_REPOSITORY https://github.com/thestk/rtaudio.git GIT_TAG 6.0.1 GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(rtaudio)
  target_link_libraries(crate-engine PRIVATE rtaudio)
  target_compile_definitions(crate-engine PRIVATE CRATE_RTAUDIO)
endif()

if(WIN32)
  target_link_libraries(crate-engine PRIVATE ws2_32)
  target_compile_definitions(crate-engine PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
  target_compile_options(crate-engine PRIVATE /W3 /O2)
else()
  target_compile_options(crate-engine PRIVATE -Wall -Wextra -O2)
  find_package(Threads REQUIRED)
  target_link_libraries(crate-engine PRIVATE Threads::Threads)
endif()
