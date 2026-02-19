"use client";

import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Float, Sparkles, Stars, Icosahedron } from '@react-three/drei';
import * as THREE from 'three';

export default function NexusCore() {
    const coreRef = useRef<THREE.Mesh>(null);
    const ringsRef = useRef<THREE.Group>(null);
    const wireRef = useRef<THREE.Mesh>(null);

    useFrame((state, delta) => {
        const t = state.clock.getElapsedTime();
        if (coreRef.current) {
            coreRef.current.rotation.y += delta * 0.1;
            coreRef.current.rotation.x += delta * 0.05;
        }
        if (wireRef.current) {
            wireRef.current.rotation.y -= delta * 0.15;
            wireRef.current.rotation.z += delta * 0.1;
        }
        if (ringsRef.current) {
            ringsRef.current.rotation.x = Math.sin(t * 0.2) * 0.2;
            ringsRef.current.rotation.y += delta * 0.2;
        }
    });

    return (
        <>
            <ambientLight intensity={0.2} />
            <directionalLight position={[5, 10, 5]} intensity={2} color="#ffffff" />
            <pointLight position={[-5, -5, -5]} intensity={1} color="#FFD700" />
            <pointLight position={[5, -5, 5]} intensity={1} color="#00FF94" />

            <Stars radius={100} depth={50} count={3000} factor={3} saturation={0} fade speed={1} />

            <Float speed={2} rotationIntensity={0.5} floatIntensity={1}>
                <group>
                    {/* Central Black Glossy Core */}
                    <mesh ref={coreRef}>
                        <sphereGeometry args={[1.2, 64, 64]} />
                        <meshStandardMaterial
                            color="#030303"
                            metalness={1}
                            roughness={0.05}
                            envMapIntensity={2}
                        />
                    </mesh>

                    {/* Holographic Wireframe Shell */}
                    <mesh ref={wireRef}>
                        <icosahedronGeometry args={[1.5, 2]} />
                        <meshBasicMaterial
                            color="#FFD700"
                            wireframe
                            transparent
                            opacity={0.15}
                        />
                    </mesh>

                    {/* Orbital Rings representing UI/AI processing */}
                    <group ref={ringsRef}>
                        {/* Primary Gold Ring */}
                        <mesh rotation={[Math.PI / 2, 0, 0]}>
                            <torusGeometry args={[2.0, 0.003, 16, 100]} />
                            <meshBasicMaterial color="#FFD700" />
                        </mesh>

                        {/* Secondary Green Ring */}
                        <mesh rotation={[Math.PI / 2.5, Math.PI / 6, 0]}>
                            <torusGeometry args={[2.2, 0.002, 16, 100]} />
                            <meshBasicMaterial color="#00FF94" transparent opacity={0.6} />
                        </mesh>

                        {/* Tertiary White Ring */}
                        <mesh rotation={[-Math.PI / 3, -Math.PI / 4, 0]}>
                            <torusGeometry args={[2.5, 0.005, 16, 100]} />
                            <meshBasicMaterial color="#ffffff" transparent opacity={0.1} />
                        </mesh>

                        {/* Inner dashed ring effect (using a thin cylinder with alpha) */}
                        <mesh rotation={[Math.PI / 2, 0, 0]}>
                            <torusGeometry args={[1.8, 0.01, 16, 60]} />
                            <meshBasicMaterial color="#FFD700" wireframe transparent opacity={0.2} />
                        </mesh>
                    </group>

                    {/* Floating Data Nodes */}
                    <Sparkles
                        count={150}
                        scale={6}
                        size={1.5}
                        speed={0.2}
                        opacity={0.5}
                        color="#FFD700"
                    />
                    <Sparkles
                        count={50}
                        scale={7}
                        size={2}
                        speed={0.4}
                        opacity={0.8}
                        color="#00FF94"
                    />
                </group>
            </Float>
        </>
    );
}
