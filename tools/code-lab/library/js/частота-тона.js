const oscillator = { frequency: { value: 0 } }; // вместо OscillatorNode из AudioContext
oscillator.frequency.value = 440;
console.log(oscillator.frequency.value);
