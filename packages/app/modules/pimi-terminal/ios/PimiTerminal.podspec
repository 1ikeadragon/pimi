Pod::Spec.new do |s|
  s.name           = 'PimiTerminal'
  s.version        = '0.1.0'
  s.summary        = 'Native terminal renderer for Pimi'
  s.description    = 'Shapes and paints terminal frames on the terminal cell grid'
  s.license        = 'PolyForm-Noncommercial-1.0.0'
  s.author         = 'Pimi'
  s.homepage       = 'https://1ikeadragon.github.io/pimi/'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.4'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
