// The LUT kernel's arguments, shared by every GPU framework: passed one by one
// to CUDA and OpenCL (gpu_api.h), and as one struct to Metal, whose kernel
// declares the same struct (kernels/ProMatchLut.metal). Keep the three in step.
#pragma once

namespace pmgpu {

struct LutKernelArgs {
    int srcPitch, dstPitch, is16f, width, height, size;
    float dmin[3], dmax[3], amount;
    // Calibration pattern: grid size n (0 = apply the LUT) and its layout, a
    // probeCols x probeRows grid over pixels [probeX0, probeX1) x [probeY0, probeY1)
    // (pm::ProbeArea).
    int probe = 0, probeCols = 1, probeRows = 1;
    int probeX0 = 0, probeY0 = 0, probeX1 = 1, probeY1 = 1;
};

static_assert(sizeof(LutKernelArgs) == 80, "Metal's copy of LutKernelArgs assumes this layout");

}  // namespace pmgpu
